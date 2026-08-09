use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::error::Result;

/// System group IDs (auto-created, cannot be deleted/renamed)
pub const MAIN_GROUP_ID: &str = "_main";
pub const LOCAL_GROUP_ID: &str = "_local";

fn system_group_name(group_id: &str) -> &'static str {
    if group_id == LOCAL_GROUP_ID {
        "Local"
    } else {
        "Main"
    }
}

/// TaskSlot: binds a Task to a position in a TaskGroup
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskSlot {
    /// Sort position (1-based, no upper limit for system groups; 1-9 for Radio grid)
    pub position: u16,
    /// Project hash
    pub project_id: String,
    /// Task ID
    pub task_id: String,
    /// Target chat ID (None = auto-select)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_chat_id: Option<String>,
}

/// TaskGroup: a group of tasks (frequency band for walkie-talkie)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskGroup {
    /// UUID
    pub id: String,
    /// Group name
    pub name: String,
    /// Optional color
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Task slots
    #[serde(default)]
    pub slots: Vec<TaskSlot>,
    /// Creation time
    pub created_at: DateTime<Utc>,
}

/// TOML wrapper struct (kept for migration backward compat)
#[allow(dead_code)]
#[derive(Debug, Default, Serialize, Deserialize)]
struct TaskGroupsFile {
    #[serde(default)]
    groups: Vec<TaskGroup>,
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/// Load a single group (with slots) by ID. Caller must hold the DB lock.
fn load_group_by_id(conn: &rusqlite::Connection, group_id: &str) -> Result<Option<TaskGroup>> {
    let mut stmt =
        conn.prepare("SELECT id, name, color, created_at FROM task_groups WHERE id = ?1")?;
    let mut rows = stmt.query(params![group_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let id: String = row.get(0)?;
    let name: String = row.get(1)?;
    let color: Option<String> = row.get(2)?;
    let created_at_str: String = row.get(3)?;
    let created_at = DateTime::parse_from_rfc3339(&created_at_str)
        .map(|dt| dt.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());

    let slots = load_slots_for_group(conn, &id)?;

    Ok(Some(TaskGroup {
        id,
        name,
        color,
        slots,
        created_at,
    }))
}

/// Load slots for a given group, ordered by position. Caller must hold the DB lock.
fn load_slots_for_group(conn: &rusqlite::Connection, group_id: &str) -> Result<Vec<TaskSlot>> {
    let mut stmt = conn.prepare(
        "SELECT position, project_id, task_id, target_chat_id \
         FROM task_group_slots WHERE group_id = ?1 ORDER BY position",
    )?;
    let rows = stmt.query_map(params![group_id], |row| {
        Ok(TaskSlot {
            position: row.get::<_, i64>(0)? as u16,
            project_id: row.get(1)?,
            task_id: row.get(2)?,
            target_chat_id: row.get(3)?,
        })
    })?;
    let mut slots = Vec::new();
    for r in rows {
        slots.push(r?);
    }
    Ok(slots)
}

/// Renumber positions for a group so they are sequential 1, 2, 3, ...
/// Caller must hold the DB lock.
fn renumber_positions(conn: &rusqlite::Connection, group_id: &str) -> Result<()> {
    let slots = load_slots_for_group(conn, group_id)?;
    // Delete all slots for the group and re-insert with sequential positions
    conn.execute(
        "DELETE FROM task_group_slots WHERE group_id = ?1",
        params![group_id],
    )?;
    for (i, slot) in slots.iter().enumerate() {
        let new_pos = (i as i64) + 1;
        conn.execute(
            "INSERT INTO task_group_slots (group_id, position, project_id, task_id, target_chat_id) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![group_id, new_pos, slot.project_id, slot.task_id, slot.target_chat_id],
        )?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Load all task groups from SQLite. Returns empty vec if no groups exist.
pub fn load_groups() -> Result<Vec<TaskGroup>> {
    let conn = crate::storage::database::connection();
    let mut stmt =
        conn.prepare("SELECT id, name, color, created_at FROM task_groups ORDER BY created_at")?;
    let group_rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, String>(3)?,
        ))
    })?;

    let mut groups = Vec::new();
    for r in group_rows {
        let (id, name, color, created_at_str) = r?;
        let created_at = DateTime::parse_from_rfc3339(&created_at_str)
            .map(|dt| dt.with_timezone(&Utc))
            .unwrap_or_else(|_| Utc::now());
        let slots = load_slots_for_group(&conn, &id)?;
        groups.push(TaskGroup {
            id,
            name,
            color,
            slots,
            created_at,
        });
    }
    Ok(groups)
}

/// Save task groups to SQLite (internal). Replaces all groups and slots within a transaction.
fn save_groups(groups: &[TaskGroup]) -> Result<()> {
    let conn = crate::storage::database::connection();
    save_groups_with_conn(&conn, groups)
}

/// Save with an existing connection (avoids double-locking).
fn save_groups_with_conn(conn: &rusqlite::Connection, groups: &[TaskGroup]) -> Result<()> {
    let tx = conn.unchecked_transaction()?;

    // CASCADE will delete all slots when groups are deleted
    tx.execute("DELETE FROM task_groups", [])?;

    for group in groups {
        let created_at_str = group.created_at.to_rfc3339();
        tx.execute(
            "INSERT INTO task_groups (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![group.id, group.name, group.color, created_at_str],
        )?;
        for slot in &group.slots {
            tx.execute(
                "INSERT INTO task_group_slots (group_id, position, project_id, task_id, target_chat_id) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    group.id,
                    slot.position as i64,
                    slot.project_id,
                    slot.task_id,
                    slot.target_chat_id
                ],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}

/// Public save for batch operations (e.g. delete_group with slot reassignment).
pub fn save_groups_pub(groups: &[TaskGroup]) -> Result<()> {
    save_groups(groups)
}

/// Ensure _main and _local system groups exist, and auto-assign unassigned tasks.
/// Called on startup and can be called periodically.
pub fn ensure_system_groups() -> Result<()> {
    let mut groups = load_groups()?;
    let mut changed = false;

    let has_main = groups.iter().any(|g| g.id == MAIN_GROUP_ID);
    let has_local = groups.iter().any(|g| g.id == LOCAL_GROUP_ID);

    if !has_main {
        groups.insert(
            0,
            TaskGroup {
                id: MAIN_GROUP_ID.to_string(),
                name: "Main".to_string(),
                color: None,
                slots: Vec::new(),
                created_at: Utc::now(),
            },
        );
        changed = true;
    }
    if !has_local {
        groups.push(TaskGroup {
            id: LOCAL_GROUP_ID.to_string(),
            name: "Local".to_string(),
            color: None,
            slots: Vec::new(),
            created_at: Utc::now(),
        });
        changed = true;
    }

    // Auto-assign unassigned tasks to _main / _local
    let project_ids = crate::storage::workspace::load_project_hashes().unwrap_or_default();

    // Collect all assigned (project_id, task_id)
    let mut assigned: std::collections::HashSet<(String, String)> =
        std::collections::HashSet::new();
    for g in &groups {
        for s in &g.slots {
            assigned.insert((s.project_id.clone(), s.task_id.clone()));
        }
    }

    let mut main_max = groups
        .iter()
        .find(|g| g.id == MAIN_GROUP_ID)
        .map(|g| g.slots.iter().map(|s| s.position).max().unwrap_or(0))
        .unwrap_or(0);
    let mut local_max = groups
        .iter()
        .find(|g| g.id == LOCAL_GROUP_ID)
        .map(|g| g.slots.iter().map(|s| s.position).max().unwrap_or(0))
        .unwrap_or(0);

    for project_id in project_ids {
        let tasks = crate::storage::tasks::load_tasks(&project_id).unwrap_or_default();

        for task in &tasks {
            let key = (project_id.clone(), task.id.clone());
            if assigned.contains(&key) {
                continue;
            }
            assigned.insert(key);
            changed = true;

            let is_local = task.id == "_local";
            let target_id = if is_local {
                LOCAL_GROUP_ID
            } else {
                MAIN_GROUP_ID
            };
            let pos = if is_local {
                local_max += 1;
                local_max
            } else {
                main_max += 1;
                main_max
            };

            if let Some(g) = groups.iter_mut().find(|g| g.id == target_id) {
                g.slots.push(TaskSlot {
                    position: pos,
                    project_id: project_id.clone(),
                    task_id: task.id.clone(),
                    target_chat_id: None,
                });
            }
        }
    }

    // Remove slots whose task no longer exists (archived/deleted)
    let mut task_cache: std::collections::HashMap<String, Vec<crate::storage::tasks::Task>> =
        std::collections::HashMap::new();
    for g in &mut groups {
        let before = g.slots.len();
        g.slots.retain(|s| {
            let tasks = task_cache.entry(s.project_id.clone()).or_insert_with(|| {
                crate::storage::tasks::load_tasks(&s.project_id).unwrap_or_default()
            });
            tasks.iter().any(|t| t.id == s.task_id)
        });
        if g.slots.len() < before {
            changed = true;
        }
        // Deduplicate within the same group
        let before2 = g.slots.len();
        let mut seen_in_group: std::collections::HashSet<(String, String)> =
            std::collections::HashSet::new();
        g.slots
            .retain(|s| seen_in_group.insert((s.project_id.clone(), s.task_id.clone())));
        if g.slots.len() < before2 {
            changed = true;
        }
        // Re-number positions to be sequential (1, 2, 3, ...)
        for (i, slot) in g.slots.iter_mut().enumerate() {
            let new_pos = (i as u16) + 1;
            if slot.position != new_pos {
                slot.position = new_pos;
                changed = true;
            }
        }
    }

    // Deduplicate: remove slots where (project_id, task_id) appears in multiple groups
    // Keep the first occurrence (by group order: _main, custom, _local)
    let mut seen: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for g in &mut groups {
        let before = g.slots.len();
        g.slots
            .retain(|s| seen.insert((s.project_id.clone(), s.task_id.clone())));
        if g.slots.len() < before {
            changed = true;
        }
    }

    if changed {
        save_groups(&groups)?;
    }
    Ok(())
}

/// Ensure one active task has a slot without rewriting every task group.
///
/// Project registration creates the Local Task and its group membership in
/// separate storage operations.  Keeping this helper narrow makes that second
/// operation reliable and idempotent, while preserving an explicit custom
/// group assignment if one already exists.
pub fn ensure_task_assignment(project_id: &str, task_id: &str, is_local: bool) -> Result<bool> {
    let target_group_id = if is_local {
        LOCAL_GROUP_ID
    } else {
        MAIN_GROUP_ID
    };
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    tx.execute(
        "INSERT OR IGNORE INTO task_groups (id, name, color, created_at) VALUES (?1, ?2, NULL, ?3)",
        params![
            target_group_id,
            system_group_name(target_group_id),
            Utc::now().to_rfc3339()
        ],
    )?;

    let already_assigned: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM task_group_slots WHERE project_id = ?1 AND task_id = ?2)",
        params![project_id, task_id],
        |row| row.get(0),
    )?;
    if already_assigned {
        tx.commit()?;
        return Ok(false);
    }

    let next_position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM task_group_slots WHERE group_id = ?1",
        params![target_group_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO task_group_slots (group_id, position, project_id, task_id, target_chat_id) \
         VALUES (?1, ?2, ?3, ?4, NULL)",
        params![target_group_id, next_position, project_id, task_id],
    )?;
    tx.commit()?;
    Ok(true)
}

/// Replace all slots for a group at once (for reordering). Returns updated group if found.
pub fn set_slots(group_id: &str, slots: Vec<TaskSlot>) -> Result<Option<TaskGroup>> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    // Check group exists
    let exists: bool = tx.query_row(
        "SELECT COUNT(*) FROM task_groups WHERE id = ?1",
        params![group_id],
        |row| row.get::<_, i64>(0),
    )? > 0;
    if !exists {
        return Ok(None);
    }

    tx.execute(
        "DELETE FROM task_group_slots WHERE group_id = ?1",
        params![group_id],
    )?;
    for slot in &slots {
        tx.execute(
            "INSERT INTO task_group_slots (group_id, position, project_id, task_id, target_chat_id) \
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                group_id,
                slot.position as i64,
                slot.project_id,
                slot.task_id,
                slot.target_chat_id
            ],
        )?;
    }
    tx.commit()?;

    load_group_by_id(&conn, group_id)
}

/// Create a new task group with a UUID.
pub fn create_group(name: String, color: Option<String>) -> Result<TaskGroup> {
    let id = Uuid::new_v4().to_string();
    let created_at = Utc::now();
    let created_at_str = created_at.to_rfc3339();

    let conn = crate::storage::database::connection();
    conn.execute(
        "INSERT INTO task_groups (id, name, color, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![id, name, color, created_at_str],
    )?;

    Ok(TaskGroup {
        id,
        name,
        color,
        slots: Vec::new(),
        created_at,
    })
}

/// Update a task group's name and/or color. Returns the updated group if found.
///
/// For `color`: `Some(Some("red"))` sets color, `Some(None)` clears color, `None` leaves unchanged.
pub fn update_group(
    id: &str,
    name: Option<String>,
    color: Option<Option<String>>,
) -> Result<Option<TaskGroup>> {
    let conn = crate::storage::database::connection();

    // Check group exists
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM task_groups WHERE id = ?1",
        params![id],
        |row| row.get::<_, i64>(0),
    )? > 0;
    if !exists {
        return Ok(None);
    }

    let tx = conn.unchecked_transaction()?;
    if let Some(new_name) = name {
        tx.execute(
            "UPDATE task_groups SET name = ?1 WHERE id = ?2",
            params![new_name, id],
        )?;
    }
    if let Some(new_color) = color {
        tx.execute(
            "UPDATE task_groups SET color = ?1 WHERE id = ?2",
            params![new_color, id],
        )?;
    }
    tx.commit()?;

    load_group_by_id(&conn, id)
}

/// Delete a task group by ID. Returns true if the group was found and removed.
pub fn delete_group(id: &str) -> Result<bool> {
    let conn = crate::storage::database::connection();
    let rows = conn.execute("DELETE FROM task_groups WHERE id = ?1", params![id])?;
    Ok(rows > 0)
}

/// Upsert a slot in a task group. Replaces any existing slot at the same position.
/// Slots are sorted by position after insertion.
/// Returns the updated group if found.
pub fn upsert_slot(group_id: &str, slot: TaskSlot) -> Result<Option<TaskGroup>> {
    let conn = crate::storage::database::connection();

    // Check group exists
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM task_groups WHERE id = ?1",
        params![group_id],
        |row| row.get::<_, i64>(0),
    )? > 0;
    if !exists {
        return Ok(None);
    }

    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM task_group_slots WHERE group_id = ?1 AND position = ?2",
        params![group_id, slot.position as i64],
    )?;
    tx.execute(
        "INSERT INTO task_group_slots (group_id, position, project_id, task_id, target_chat_id) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            group_id,
            slot.position as i64,
            slot.project_id,
            slot.task_id,
            slot.target_chat_id
        ],
    )?;
    tx.commit()?;

    load_group_by_id(&conn, group_id)
}

/// Remove a slot from a task group by position.
/// Renumbers remaining positions sequentially.
/// Returns the updated group if found.
pub fn remove_slot(group_id: &str, position: u16) -> Result<Option<TaskGroup>> {
    let conn = crate::storage::database::connection();

    // Check group exists
    let exists: bool = conn.query_row(
        "SELECT COUNT(*) FROM task_groups WHERE id = ?1",
        params![group_id],
        |row| row.get::<_, i64>(0),
    )? > 0;
    if !exists {
        return Ok(None);
    }

    let tx = conn.unchecked_transaction()?;
    tx.execute(
        "DELETE FROM task_group_slots WHERE group_id = ?1 AND position = ?2",
        params![group_id, position as i64],
    )?;
    renumber_positions(&tx, group_id)?;
    tx.commit()?;

    load_group_by_id(&conn, group_id)
}

/// Move one task between groups atomically.
///
/// A move must not be composed from client-side DELETE and INSERT requests:
/// that exposes an unassigned intermediate state, emits two change events, and
/// can leave the task missing or duplicated if the second request fails.
pub fn move_slot(
    from_group_id: &str,
    to_group_id: &str,
    project_id: &str,
    task_id: &str,
) -> Result<Option<TaskGroup>> {
    let conn = crate::storage::database::connection();
    let tx = conn.unchecked_transaction()?;

    let groups_exist: i64 = tx.query_row(
        "SELECT COUNT(*) FROM task_groups WHERE id IN (?1, ?2)",
        params![from_group_id, to_group_id],
        |row| row.get(0),
    )?;
    let expected_groups = if from_group_id == to_group_id { 1 } else { 2 };
    if groups_exist != expected_groups {
        return Ok(None);
    }

    if from_group_id == to_group_id {
        tx.commit()?;
        return load_group_by_id(&conn, to_group_id);
    }

    let target_chat_id: Option<Option<String>> = tx
        .query_row(
            "SELECT target_chat_id FROM task_group_slots \
             WHERE group_id = ?1 AND project_id = ?2 AND task_id = ?3",
            params![from_group_id, project_id, task_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(target_chat_id) = target_chat_id else {
        return Ok(None);
    };

    tx.execute(
        "DELETE FROM task_group_slots \
         WHERE group_id = ?1 AND project_id = ?2 AND task_id = ?3",
        params![from_group_id, project_id, task_id],
    )?;
    renumber_positions(&tx, from_group_id)?;

    // Defensive cleanup for data produced by the old two-request move path.
    tx.execute(
        "DELETE FROM task_group_slots \
         WHERE group_id = ?1 AND project_id = ?2 AND task_id = ?3",
        params![to_group_id, project_id, task_id],
    )?;
    let next_position: i64 = tx.query_row(
        "SELECT COALESCE(MAX(position), 0) + 1 FROM task_group_slots WHERE group_id = ?1",
        params![to_group_id],
        |row| row.get(0),
    )?;
    tx.execute(
        "INSERT INTO task_group_slots \
         (group_id, position, project_id, task_id, target_chat_id) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            to_group_id,
            next_position,
            project_id,
            task_id,
            target_chat_id
        ],
    )?;
    tx.commit()?;

    load_group_by_id(&conn, to_group_id)
}

/// Remove a task from all groups (called when task is archived/deleted).
/// Returns true if any slot was removed.
pub fn remove_task_from_all_groups(project_id: &str, task_id: &str) -> bool {
    let conn = crate::storage::database::connection();

    let result: Result<bool> = (|| {
        let tx = conn.unchecked_transaction()?;

        // Find affected groups
        let affected_groups: Vec<String> = {
            let mut stmt = tx.prepare(
                "SELECT DISTINCT group_id FROM task_group_slots \
                 WHERE project_id = ?1 AND task_id = ?2",
            )?;
            let rows =
                stmt.query_map(params![project_id, task_id], |row| row.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };

        if affected_groups.is_empty() {
            return Ok(false);
        }

        // Delete the slots
        let deleted = tx.execute(
            "DELETE FROM task_group_slots WHERE project_id = ?1 AND task_id = ?2",
            params![project_id, task_id],
        )?;

        // Renumber positions for each affected group
        for gid in &affected_groups {
            renumber_positions(&tx, gid)?;
        }

        tx.commit()?;
        Ok(deleted > 0)
    })();

    result.unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Shared with other test modules that touch the DB;
    // see `crate::storage::database::test_lock` for rationale.
    use crate::storage::database::test_lock as FILE_LOCK_FN;

    /// RAII guard that overrides HOME to a temp dir so tests don't pollute
    /// the user's real `~/.grove/grove.db`.
    struct HomeGuard {
        prev: String,
        temp: std::path::PathBuf,
    }
    impl Drop for HomeGuard {
        fn drop(&mut self) {
            std::env::set_var("HOME", &self.prev);
            let _ = std::fs::remove_dir_all(&self.temp);
        }
    }
    fn sandbox_home() -> HomeGuard {
        let prev = std::env::var("HOME").unwrap_or_default();
        let temp = std::env::temp_dir().join(format!(
            "grove-taskgroups-storage-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&temp).unwrap();
        std::env::set_var("HOME", &temp);
        HomeGuard { prev, temp }
    }

    /// Helper that creates a group and ensures it gets deleted on drop.
    struct TestGroup {
        pub id: String,
    }

    impl TestGroup {
        fn create(name: &str, color: Option<String>) -> (Self, TaskGroup) {
            let group = create_group(name.to_string(), color).expect("create_group failed");
            let guard = Self {
                id: group.id.clone(),
            };
            (guard, group)
        }
    }

    impl Drop for TestGroup {
        fn drop(&mut self) {
            let _ = delete_group(&self.id);
        }
    }

    #[test]
    fn test_create_and_load_group() {
        let _lock = FILE_LOCK_FN().blocking_lock();
        let _home = sandbox_home();
        let (guard, group) = TestGroup::create("test_create_load", Some("blue".into()));

        assert_eq!(group.name, "test_create_load");
        assert_eq!(group.color, Some("blue".to_string()));
        assert!(group.slots.is_empty());

        // Verify it appears in load_groups
        let groups = load_groups().unwrap();
        let found = groups.iter().find(|g| g.id == guard.id);
        assert!(
            found.is_some(),
            "created group should appear in load_groups"
        );
        assert_eq!(found.unwrap().name, "test_create_load");
    }

    #[test]
    fn test_update_group() {
        let _lock = FILE_LOCK_FN().blocking_lock();
        let _home = sandbox_home();
        let (guard, _group) = TestGroup::create("test_update_orig", None);

        // Update name only
        let updated = update_group(&guard.id, Some("test_update_renamed".into()), None)
            .unwrap()
            .expect("group should be found");
        assert_eq!(updated.name, "test_update_renamed");
        assert_eq!(updated.color, None);

        // Set color
        let updated = update_group(&guard.id, None, Some(Some("red".into())))
            .unwrap()
            .expect("group should be found");
        assert_eq!(updated.name, "test_update_renamed");
        assert_eq!(updated.color, Some("red".to_string()));

        // Clear color
        let updated = update_group(&guard.id, None, Some(None))
            .unwrap()
            .expect("group should be found");
        assert_eq!(updated.color, None);

        // Update non-existent group
        let result = update_group("nonexistent-id", Some("x".into()), None).unwrap();
        assert!(result.is_none());
    }

    #[test]
    fn test_delete_group() {
        let _lock = FILE_LOCK_FN().blocking_lock();
        let _home = sandbox_home();
        let group = create_group("test_delete_me".into(), None).unwrap();
        let id = group.id.clone();

        // Delete should succeed
        assert!(delete_group(&id).unwrap());

        // Second delete should return false
        assert!(!delete_group(&id).unwrap());

        // Should no longer appear in load_groups
        let groups = load_groups().unwrap();
        assert!(groups.iter().all(|g| g.id != id));
    }

    #[test]
    fn test_upsert_and_remove_slot() {
        let _lock = FILE_LOCK_FN().blocking_lock();
        let _home = sandbox_home();
        let (guard, _group) = TestGroup::create("test_slots", None);

        // Add a slot at position 1
        let slot1 = TaskSlot {
            position: 1,
            project_id: "proj_a".into(),
            task_id: "task_1".into(),
            target_chat_id: None,
        };
        let updated = upsert_slot(&guard.id, slot1).unwrap().unwrap();
        assert_eq!(updated.slots.len(), 1);
        assert_eq!(updated.slots[0].position, 1);
        assert_eq!(updated.slots[0].task_id, "task_1");

        // Add a slot at position 3
        let slot3 = TaskSlot {
            position: 3,
            project_id: "proj_b".into(),
            task_id: "task_3".into(),
            target_chat_id: Some("chat_x".into()),
        };
        let updated = upsert_slot(&guard.id, slot3).unwrap().unwrap();
        assert_eq!(updated.slots.len(), 2);

        // Upsert (replace) slot at position 1
        let slot1_new = TaskSlot {
            position: 1,
            project_id: "proj_c".into(),
            task_id: "task_1_replaced".into(),
            target_chat_id: None,
        };
        let updated = upsert_slot(&guard.id, slot1_new).unwrap().unwrap();
        assert_eq!(updated.slots.len(), 2);
        assert_eq!(updated.slots[0].task_id, "task_1_replaced");

        // Remove slot at position 3
        let updated = remove_slot(&guard.id, 3).unwrap().unwrap();
        assert_eq!(updated.slots.len(), 1);
        assert_eq!(updated.slots[0].position, 1);

        // Remove non-existent slot (should still succeed, just no change)
        let updated = remove_slot(&guard.id, 9).unwrap().unwrap();
        assert_eq!(updated.slots.len(), 1);

        // Upsert/remove on non-existent group
        let slot = TaskSlot {
            position: 1,
            project_id: "x".into(),
            task_id: "y".into(),
            target_chat_id: None,
        };
        assert!(upsert_slot("nonexistent", slot).unwrap().is_none());
        assert!(remove_slot("nonexistent", 1).unwrap().is_none());
    }

    #[test]
    fn test_slot_sorting() {
        let _lock = FILE_LOCK_FN().blocking_lock();
        let _home = sandbox_home();
        let (guard, _group) = TestGroup::create("test_slot_sort", None);

        // Insert slots in reverse order: 5, 3, 1, 9, 2
        for pos in [5, 3, 1, 9, 2] {
            let slot = TaskSlot {
                position: pos,
                project_id: format!("proj_{pos}"),
                task_id: format!("task_{pos}"),
                target_chat_id: None,
            };
            upsert_slot(&guard.id, slot).unwrap();
        }

        // Load and verify slots are sorted by position
        let groups = load_groups().unwrap();
        let group = groups.iter().find(|g| g.id == guard.id).unwrap();
        let positions: Vec<u16> = group.slots.iter().map(|s| s.position).collect();
        assert_eq!(positions, vec![1, 2, 3, 5, 9]);
    }

    #[test]
    fn test_ensure_task_assignment_repairs_missing_local_slot() {
        let _lock = FILE_LOCK_FN().blocking_lock();
        let home = sandbox_home();
        let project_path = home.temp.join("repair-project");
        std::fs::create_dir_all(&project_path).unwrap();
        let project_path = project_path.to_string_lossy().to_string();

        crate::storage::workspace::add_project("repair-project", &project_path).unwrap();
        let registered = crate::storage::workspace::load_projects()
            .unwrap()
            .into_iter()
            .find(|project| project.name == "repair-project")
            .unwrap();
        let project_id = crate::storage::workspace::project_hash(&registered.path);

        // Repo registration itself establishes the Local membership; startup
        // repair is only for historical or interrupted registrations.
        let groups = load_groups().unwrap();
        let local = groups.iter().find(|g| g.id == LOCAL_GROUP_ID).unwrap();
        assert!(local.slots.iter().any(|slot| {
            slot.project_id == project_id && slot.task_id == crate::storage::tasks::LOCAL_TASK_ID
        }));

        {
            let conn = crate::storage::database::connection();
            conn.execute(
                "DELETE FROM task_group_slots WHERE project_id = ?1 AND task_id = ?2",
                params![project_id, crate::storage::tasks::LOCAL_TASK_ID],
            )
            .unwrap();
        }

        ensure_system_groups().unwrap();

        let groups = load_groups().unwrap();
        let local = groups.iter().find(|g| g.id == LOCAL_GROUP_ID).unwrap();
        assert!(local.slots.iter().any(|slot| {
            slot.project_id == project_id && slot.task_id == crate::storage::tasks::LOCAL_TASK_ID
        }));
    }

    #[test]
    fn test_ensure_task_assignment_preserves_custom_group() {
        let _lock = FILE_LOCK_FN().blocking_lock();
        let _home = sandbox_home();
        ensure_system_groups().unwrap();
        let custom = create_group("Focused".to_string(), None).unwrap();
        upsert_slot(
            &custom.id,
            TaskSlot {
                position: 1,
                project_id: "project-a".to_string(),
                task_id: "_local".to_string(),
                target_chat_id: None,
            },
        )
        .unwrap();

        assert!(!ensure_task_assignment("project-a", "_local", true).unwrap());
        let groups = load_groups().unwrap();
        assert_eq!(
            groups
                .iter()
                .flat_map(|group| group.slots.iter())
                .filter(|slot| slot.project_id == "project-a" && slot.task_id == "_local")
                .count(),
            1
        );
        assert!(groups
            .iter()
            .find(|group| group.id == custom.id)
            .unwrap()
            .slots
            .iter()
            .any(|slot| slot.project_id == "project-a" && slot.task_id == "_local"));
    }

    #[test]
    fn test_move_slot_is_atomic_and_preserves_identity() {
        let _lock = FILE_LOCK_FN().blocking_lock();
        let _home = sandbox_home();
        ensure_system_groups().unwrap();
        let custom = create_group("Focused".to_string(), None).unwrap();
        upsert_slot(
            LOCAL_GROUP_ID,
            TaskSlot {
                position: 1,
                project_id: "project-a".to_string(),
                task_id: "_local".to_string(),
                target_chat_id: Some("chat-a".to_string()),
            },
        )
        .unwrap();

        let moved = move_slot(LOCAL_GROUP_ID, &custom.id, "project-a", "_local")
            .unwrap()
            .unwrap();
        assert!(moved.slots.iter().any(|slot| {
            slot.project_id == "project-a"
                && slot.task_id == "_local"
                && slot.target_chat_id.as_deref() == Some("chat-a")
        }));

        let groups = load_groups().unwrap();
        let local = groups
            .iter()
            .find(|group| group.id == LOCAL_GROUP_ID)
            .unwrap();
        assert!(local
            .slots
            .iter()
            .all(|slot| { slot.project_id != "project-a" || slot.task_id != "_local" }));
        assert_eq!(
            groups
                .iter()
                .flat_map(|group| group.slots.iter())
                .filter(|slot| slot.project_id == "project-a" && slot.task_id == "_local")
                .count(),
            1
        );
    }
}
