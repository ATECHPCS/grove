//! Per-plugin file storage, split into three **scopes** under the plugin's data
//! dir `~/.grove/plugins-data/<plugin_id>/`:
//!   - `global/`            — cross-project (user prefs, auth tokens)
//!   - `project/<pid>/`     — one project (config, index cache)
//!   - `task/<pid>/<tid>/`  — one task (drafts, transient state)
//!
//! Each scope is reachable from both sides with the **same** logical API:
//!   - frontend (iframe) via the SDK file ops (path-confined, bridged);
//!   - node backend / MCP server via direct FS — Grove launches those with
//!     `node --permission` granting `--allow-fs-*` exactly to these dirs.
//!
//! Paths are relative to the scope dir; `..` segments are rejected.

use crate::error::Result;

/// Which sub-tree of the plugin's data dir a read/write targets.
pub enum Scope {
    /// Cross-project storage.
    Global,
    /// Per-project storage, keyed by project id (path hash).
    Project(String),
    /// Per-task storage, keyed by (project id, task id).
    Task(String, String),
}

/// Reject ids that could escape their scope dir. Ids come from Grove's own
/// registry (path hashes / uuids), but validate defensively anyway.
fn safe_id(s: &str) -> Result<&str> {
    if s.is_empty() || s.contains('/') || s.contains('\\') || s.contains("..") {
        return Err(crate::error::GroveError::storage("invalid scope id"));
    }
    Ok(s)
}

impl Scope {
    /// On-disk segment for this scope (e.g. `global`, `project/<pid>`).
    fn seg(&self) -> Result<std::path::PathBuf> {
        Ok(match self {
            Scope::Global => std::path::PathBuf::from("global"),
            Scope::Project(p) => std::path::Path::new("project").join(safe_id(p)?),
            Scope::Task(p, t) => std::path::Path::new("task")
                .join(safe_id(p)?)
                .join(safe_id(t)?),
        })
    }
}

/// The plugin's data-dir root (parent of all scopes).
pub fn data_dir(plugin_id: &str) -> std::path::PathBuf {
    crate::storage::grove_dir()
        .join("plugins-data")
        .join(plugin_id)
}

/// Absolute dir for a given scope (created on demand by writes). Used both for
/// FS ops here and to compute the `--allow-fs-*` grants for node processes.
pub fn scope_dir(plugin_id: &str, scope: &Scope) -> Result<std::path::PathBuf> {
    Ok(data_dir(plugin_id).join(scope.seg()?))
}

/// Resolve a relative path inside a scope dir, refusing `..` traversal.
fn resolve(plugin_id: &str, scope: &Scope, rel: &str) -> Result<std::path::PathBuf> {
    let rp = std::path::Path::new(rel);
    if rp.is_absolute()
        || rp.components().any(|c| {
            matches!(
                c,
                std::path::Component::ParentDir
                    | std::path::Component::RootDir
                    | std::path::Component::Prefix(_)
            )
        })
    {
        return Err(crate::error::GroveError::storage(
            "path must be relative and within scope",
        ));
    }
    Ok(scope_dir(plugin_id, scope)?.join(rel))
}

/// Read a text file (None if it doesn't exist).
pub fn read_file(plugin_id: &str, scope: &Scope, rel: &str) -> Result<Option<String>> {
    let path = resolve(plugin_id, scope, rel)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read_to_string(&path)?))
}

/// Write a text file (creating parent dirs as needed).
pub fn write_file(plugin_id: &str, scope: &Scope, rel: &str, content: &str) -> Result<()> {
    let path = resolve(plugin_id, scope, rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, content)?;
    Ok(())
}

/// Delete a file. Returns whether it existed.
pub fn delete_file(plugin_id: &str, scope: &Scope, rel: &str) -> Result<bool> {
    let path = resolve(plugin_id, scope, rel)?;
    if path.exists() {
        std::fs::remove_file(&path)?;
        Ok(true)
    } else {
        Ok(false)
    }
}

/// Read a binary file (None if it doesn't exist).
pub fn read_bytes(plugin_id: &str, scope: &Scope, rel: &str) -> Result<Option<Vec<u8>>> {
    let path = resolve(plugin_id, scope, rel)?;
    if !path.exists() {
        return Ok(None);
    }
    Ok(Some(std::fs::read(&path)?))
}

/// Write a binary file (creating parent dirs as needed).
pub fn write_bytes(plugin_id: &str, scope: &Scope, rel: &str, bytes: &[u8]) -> Result<()> {
    let path = resolve(plugin_id, scope, rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&path, bytes)?;
    Ok(())
}

/// List entries (name + is_dir) directly under `rel` (a dir relative to the
/// scope dir; `""` = the scope root). Empty if the dir doesn't exist yet.
pub fn list(plugin_id: &str, scope: &Scope, rel: &str) -> Result<Vec<(String, bool)>> {
    let dir = resolve(plugin_id, scope, rel)?;
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push((entry.file_name().to_string_lossy().to_string(), is_dir));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(entries)
}

/// Remove the plugin's whole data dir (all scopes) — called on uninstall.
pub fn remove_all(plugin_id: &str) -> Result<()> {
    let dir = data_dir(plugin_id);
    if dir.exists() {
        std::fs::remove_dir_all(&dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::Scope;

    // The `..` guard runs before any FS access, so these never touch disk.
    #[test]
    fn rejects_parent_traversal() {
        assert!(super::write_file("t", &Scope::Global, "../escape.txt", "x").is_err());
        assert!(super::read_file("t", &Scope::Global, "a/../../b").is_err());
        assert!(super::delete_file("t", &Scope::Global, "..").is_err());
        assert!(super::list("t", &Scope::Global, "x/../y").is_err());
    }

    #[test]
    fn rejects_absolute_path() {
        assert!(super::write_file("t", &Scope::Global, "/etc/passwd", "x").is_err());
        assert!(super::read_file("t", &Scope::Global, "/etc/passwd").is_err());
    }

    #[test]
    fn rejects_scope_id_escape() {
        assert!(super::read_file("t", &Scope::Project("../x".into()), "a").is_err());
        assert!(super::read_file("t", &Scope::Task("p".into(), "../x".into()), "a").is_err());
        assert!(super::read_file("t", &Scope::Project("a/b".into()), "a").is_err());
    }

    #[test]
    fn scope_segments() {
        assert_eq!(
            Scope::Global.seg().unwrap(),
            std::path::PathBuf::from("global")
        );
        assert_eq!(
            Scope::Project("pid".into()).seg().unwrap(),
            std::path::Path::new("project").join("pid")
        );
        assert_eq!(
            Scope::Task("pid".into(), "tid".into()).seg().unwrap(),
            std::path::Path::new("task").join("pid").join("tid")
        );
    }
}
