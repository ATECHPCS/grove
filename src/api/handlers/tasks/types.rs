//! Task DTOs (request/response types)

use serde::{Deserialize, Serialize};

use super::super::projects::TaskResponse;

/// Task list query parameters
#[derive(Debug, Deserialize)]
pub struct TaskListQuery {
    pub filter: Option<String>, // "active" | "archived"
}

#[derive(Debug, Deserialize)]
pub struct ArchiveQuery {
    /// If true, skip safety checks and archive immediately.
    #[serde(default)]
    pub force: Option<bool>,
}

#[derive(Debug, Serialize)]
pub struct ArchiveConfirmResponse {
    pub error: String,
    pub code: String,
    pub task_name: String,
    pub branch: String,
    pub target: String,
    pub worktree_dirty: bool,
    pub branch_merged: bool,
    pub dirty_check_failed: bool,
    pub merge_check_failed: bool,
}

impl ArchiveConfirmResponse {
    /// Create an error response with default/safe values for status fields
    pub fn error(code: &str, error: &str, task_name: String) -> Self {
        Self {
            error: error.to_string(),
            code: code.to_string(),
            task_name,
            branch: String::new(),
            target: String::new(),
            worktree_dirty: false,
            // Default to merged to avoid false "not merged" warnings
            branch_merged: true,
            // Mark checks as failed to indicate we couldn't verify
            dirty_check_failed: true,
            merge_check_failed: true,
        }
    }

    /// Create a confirmation required response with actual check results
    pub fn confirm_required(
        task_name: String,
        branch: String,
        target: String,
        worktree_dirty: bool,
        branch_merged: bool,
        dirty_check_failed: bool,
        merge_check_failed: bool,
    ) -> Self {
        Self {
            error: "Archive requires confirmation".to_string(),
            code: "ARCHIVE_CONFIRM_REQUIRED".to_string(),
            task_name,
            branch,
            target,
            worktree_dirty,
            branch_merged,
            dirty_check_failed,
            merge_check_failed,
        }
    }
}

/// Task list response
#[derive(Debug, Serialize)]
pub struct TaskListResponse {
    pub tasks: Vec<TaskResponse>,
}

/// Create task request
#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub name: String,
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Rename task request
#[derive(Debug, Deserialize)]
pub struct RenameTaskRequest {
    pub name: String,
}

fn default_true() -> bool {
    true
}

/// Composite "create task + auto-start an agent" request (POST /tasks/dispatch).
/// The single call an external caller (e.g. nanobot) makes to file a bug.
#[derive(Debug, Deserialize)]
pub struct DispatchRequest {
    /// Task title / one-line bug summary.
    pub title: String,
    /// Full bug description, sent to the agent as its opening prompt.
    #[serde(default)]
    pub body: Option<String>,
    /// Agent id ("claude", "codex", …). Defaults to the configured ACP agent.
    #[serde(default)]
    pub agent: Option<String>,
    /// Start an agent immediately (default true). When false the card is just
    /// filed on the board for a human to dispatch later.
    #[serde(default = "default_true")]
    pub auto_start: bool,
    /// Target branch for the worktree (defaults to the project's current branch).
    #[serde(default)]
    pub target: Option<String>,
    /// Initial board column: "todo" or "planned" (default "planned" when
    /// auto_start, else "todo").
    #[serde(default)]
    pub into: Option<String>,
    /// Provenance of the originating record as a raw JSON string
    /// `{ "system": str, "id": str, "agent": str }`. When present with a
    /// non-empty system+id, the server derives an `origin_key` and dedups:
    /// re-filing the same source returns the existing non-terminal card
    /// instead of creating a duplicate. Empty/absent → always create.
    #[serde(default)]
    pub origin_ref: Option<String>,
    /// On a dedup hit, overwrite the existing card's title/body from this
    /// payload. Default false — avoid clobbering an in-flight agent's context.
    #[serde(default)]
    pub update_on_match: bool,
}

/// Parsed `origin_ref` payload. `agent` is the nanobot agent that filed the
/// card (andy/cody/stefany/wilson); used to route escalations back (F2).
#[derive(Debug, Clone, Deserialize)]
pub struct OriginRef {
    #[serde(default)]
    pub system: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub agent: String,
}

/// Max byte length accepted for a raw `origin_ref` JSON string.
pub const ORIGIN_REF_MAX_BYTES: usize = 1024;

impl OriginRef {
    /// Parse + validate a raw `origin_ref` JSON string. Returns:
    /// - `Ok(None)` when the input is absent/empty (human-created card),
    /// - `Ok(Some(_))` when it parses and carries a non-empty system + id,
    /// - `Err(msg)` when it is oversized, unparseable, or missing system/id.
    pub fn parse(raw: Option<&str>) -> Result<Option<OriginRef>, String> {
        let raw = match raw.map(str::trim) {
            Some(s) if !s.is_empty() => s,
            _ => return Ok(None),
        };
        if raw.len() > ORIGIN_REF_MAX_BYTES {
            return Err(format!(
                "origin_ref too large (max {ORIGIN_REF_MAX_BYTES} bytes)"
            ));
        }
        let parsed: OriginRef =
            serde_json::from_str(raw).map_err(|e| format!("origin_ref not valid JSON: {e}"))?;
        if parsed.system.trim().is_empty() || parsed.id.trim().is_empty() {
            return Err("origin_ref requires non-empty 'system' and 'id'".to_string());
        }
        Ok(Some(parsed))
    }

    /// Canonical dedup key: `"{system}:{id}"`, lowercased and trimmed. Derived
    /// server-side, never trusted from the client, so the key stays canonical.
    pub fn origin_key(&self) -> String {
        format!(
            "{}:{}",
            self.system.trim().to_lowercase(),
            self.id.trim().to_lowercase()
        )
    }

    /// Re-serialize to the canonical JSON stored in `tasks.origin_ref`.
    pub fn to_json(&self) -> String {
        serde_json::json!({
            "system": self.system.trim(),
            "id": self.id.trim(),
            "agent": self.agent.trim(),
        })
        .to_string()
    }
}

/// Start an agent on an existing task (POST /tasks/{taskId}/start). The board's
/// "drag a TODO card into PLANNED" gesture. The task + worktree already exist;
/// this only launches the agent and files the card into PLANNED.
#[derive(Debug, Deserialize)]
pub struct StartTaskRequest {
    /// Agent id ("claude", "codex", …). Defaults to the configured ACP agent.
    #[serde(default)]
    pub agent: Option<String>,
    /// Optional extra prompt appended below the task title. A manual board start
    /// sends none — the agent picks up the worktree's own notes/context.
    #[serde(default)]
    pub body: Option<String>,
}

/// Response for POST /tasks/dispatch.
#[derive(Debug, Serialize)]
pub struct DispatchResponse {
    pub task: TaskResponse,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chat_id: Option<String>,
    pub board_column: String,
    /// Whether an agent session was actually started for the task.
    pub agent_started: bool,
    /// Reason the agent did not start (task is still created + filed on the
    /// board). Present only on partial success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_error: Option<String>,
    /// True when an existing non-terminal card matched the request's
    /// `origin_key` and was returned instead of creating a duplicate (F1).
    /// The caller should say "already tracked" rather than "new card filed".
    pub matched_existing: bool,
}

/// Move task to a Kanban board column request
#[derive(Debug, Deserialize)]
pub struct MoveStageRequest {
    /// Target column: "todo" | "planned" | "ongoing" | "done".
    pub board_column: String,
    /// Explicit position within the column. When omitted, the task is appended
    /// to the end of the target column.
    #[serde(default)]
    pub board_order: Option<i64>,
}

/// Notes response
#[derive(Debug, Serialize)]
pub struct NotesResponse {
    pub content: String,
}

/// Update notes request
#[derive(Debug, Deserialize)]
pub struct UpdateNotesRequest {
    pub content: String,
}

/// Commit request
#[derive(Debug, Deserialize)]
pub struct CommitRequest {
    pub message: String,
}

/// Merge request
#[derive(Debug, Deserialize)]
pub struct MergeRequest {
    /// Merge method: "squash" or "merge-commit" (default: auto-select based on commit count)
    #[serde(default)]
    pub method: Option<String>,
}

/// Rebase-to request (change target branch)
#[derive(Debug, Deserialize)]
pub struct RebaseToRequest {
    pub target: String,
}

/// Git operation response
#[derive(Debug, Serialize)]
pub struct GitOperationResponse {
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// Diff file status
#[derive(Debug, Clone, Serialize)]
pub enum DiffStatus {
    #[serde(rename = "A")]
    Added,
    #[serde(rename = "M")]
    Modified,
    #[serde(rename = "D")]
    Deleted,
    #[serde(rename = "R")]
    Renamed,
    #[serde(rename = "U")]
    Untracked,
}

/// Diff file entry
#[derive(Debug, Serialize)]
pub struct DiffFileEntry {
    pub path: String,
    pub status: DiffStatus,
    pub additions: u32,
    pub deletions: u32,
    pub is_binary: bool,
}

/// Diff response
#[derive(Debug, Serialize)]
pub struct DiffResponse {
    pub files: Vec<DiffFileEntry>,
    pub total_additions: u32,
    pub total_deletions: u32,
}

/// Diff query parameters
#[derive(Debug, Deserialize)]
pub struct DiffQuery {
    /// Start ref (defaults to task.target)
    pub from_ref: Option<String>,
    /// End ref (commit hash); omit for working tree comparison
    pub to_ref: Option<String>,
}

/// Single file diff query parameters
#[derive(Debug, Deserialize)]
pub struct SingleFileDiffQuery {
    pub path: String,
    pub from_ref: Option<String>,
    pub to_ref: Option<String>,
}

/// Commit entry for history
#[derive(Debug, Serialize)]
pub struct CommitEntry {
    pub hash: String,
    pub message: String,
    pub time_ago: String,
}

/// Commits response
#[derive(Debug, Serialize)]
pub struct CommitsResponse {
    pub commits: Vec<CommitEntry>,
    pub total: u32,
    /// Number of leading commits (newest-first) to skip when building version options.
    /// When working tree is clean: equals the count of consecutive commits whose tree
    /// matches HEAD's tree (at least 1, since commits[0] IS HEAD).
    /// When working tree is dirty: 0 (all commits become versions, Latest = working tree).
    pub skip_versions: u32,
}

/// Review comment reply entry
#[derive(Debug, Serialize)]
pub struct ReviewCommentReplyEntry {
    pub id: u32,
    pub content: String,
    pub agent: String,
    pub model: String,
    pub role: String,
    pub timestamp: String,
}

/// Review comment entry
#[derive(Debug, Serialize)]
pub struct ReviewCommentEntry {
    pub id: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comment_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    pub content: String,
    pub agent: String,
    pub model: String,
    pub role: String,
    pub timestamp: String,
    pub status: String,
    pub replies: Vec<ReviewCommentReplyEntry>,
}

/// Review comments response
#[derive(Debug, Serialize)]
pub struct ReviewCommentsResponse {
    pub comments: Vec<ReviewCommentEntry>,
    pub open_count: u32,
    pub resolved_count: u32,
    pub outdated_count: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub git_user_name: Option<String>,
}

/// File metadata
#[derive(Debug, Serialize, Deserialize)]
pub struct FileMetadata {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

/// File list response
#[derive(serde::Serialize)]
pub struct FilesResponse {
    pub files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<Vec<FileMetadata>>,
}

/// File content response
#[derive(Debug, Serialize)]
pub struct FileContentResponse {
    pub content: String,
    pub path: String,
}

/// Write file request
#[derive(Debug, Deserialize)]
pub struct WriteFileRequest {
    pub content: String,
}

/// File path query parameter
#[derive(Debug, Deserialize)]
pub struct FilePathQuery {
    pub path: String,
    pub action: Option<String>,
}

/// Reply to review comment request
#[derive(Debug, Deserialize)]
pub struct ReplyCommentRequest {
    pub comment_id: u32,
    pub message: String,
    pub author: Option<String>,
}

/// Update review comment status request
#[derive(Debug, Deserialize)]
pub struct UpdateCommentStatusRequest {
    pub status: String, // "open" | "resolved"
}

/// Edit comment content request
#[derive(Debug, Deserialize)]
pub struct EditCommentRequest {
    pub content: String,
}

/// Edit reply content request
#[derive(Debug, Deserialize)]
pub struct EditReplyRequest {
    pub content: String,
}

/// Bulk delete review comments request
#[derive(Debug, Deserialize)]
pub struct BulkDeleteRequest {
    /// Status filter (OR): ["resolved", "outdated", "open"]
    pub statuses: Option<Vec<String>>,
    /// Author filter (OR): ["Claude", "You"]
    pub authors: Option<Vec<String>>,
}

/// Create review comment request
#[derive(Debug, Deserialize)]
pub struct CreateReviewCommentRequest {
    pub content: String,
    /// Comment type: "inline" | "file" | "project" (defaults to "inline")
    pub comment_type: Option<String>,
    /// Structured fields
    pub file_path: Option<String>,
    pub side: Option<String>,
    pub start_line: Option<u32>,
    pub end_line: Option<u32>,
    pub author: Option<String>,
}

/// Create file request
#[derive(Debug, Deserialize)]
pub struct CreateFileRequest {
    pub path: String,
    #[serde(default)]
    pub content: Option<String>,
}

/// Create directory request
#[derive(Debug, Deserialize)]
pub struct CreateDirectoryRequest {
    pub path: String,
}

/// Delete file/directory request (via query param)
#[derive(Debug, Deserialize)]
pub struct DeletePathQuery {
    pub path: String,
}

/// Copy file request
#[derive(Debug, Deserialize)]
pub struct CopyFileRequest {
    pub source: String,
    pub destination: String,
}

/// Move file request
#[derive(Debug, Deserialize)]
pub struct MoveFileRequest {
    pub source: String,
    pub destination: String,
}

/// File system operation response
#[derive(Debug, Serialize)]
pub struct FsOperationResponse {
    pub success: bool,
    pub message: String,
}

/// Artifact file entry
#[derive(Debug, Serialize)]
pub struct ArtifactFile {
    pub name: String,
    pub path: String,
    pub directory: String,
    pub size: u64,
    pub modified_at: String,
    pub is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub favicon: Option<String>,
}

/// Artifacts response
#[derive(Debug, Serialize)]
pub struct ArtifactsResponse {
    pub input: Vec<ArtifactFile>,
    pub output: Vec<ArtifactFile>,
}

/// Artifact query parameters
#[derive(Debug, Deserialize)]
pub struct ArtifactQuery {
    pub path: String,
    pub dir: String,
    pub action: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GraphResponse {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Serialize)]
pub struct GraphNode {
    pub chat_id: String,
    pub name: String,
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duty: Option<String>,
    pub status: String,
    /// Count of pending messages where this node is the recipient.
    pub pending_in: usize,
    /// Count of pending messages where this node is the sender.
    pub pending_out: usize,
    /// Pending messages involving this node, with sender/receiver names resolved.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub pending_messages: Vec<PendingMessageInfo>,
}

/// A pending message summary for hover cards.
#[derive(Debug, Clone, Serialize)]
pub struct PendingMessageInfo {
    pub from: String,
    pub from_name: String,
    pub to: String,
    pub to_name: String,
    /// First 120 chars of the message body.
    pub body_excerpt: String,
}

#[derive(Debug, Serialize)]
pub struct GraphEdge {
    pub edge_id: i64,
    pub from: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub purpose: Option<String>,
    pub state: String,
    /// Pending message on this edge, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_message: Option<PendingMessageInfo>,
}

#[derive(Debug, Deserialize)]
pub struct SpawnNodeRequest {
    pub from_chat_id: Option<String>,
    pub agent: String,
    pub name: String,
    pub duty: Option<String>,
    pub purpose: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct AddEdgeRequest {
    pub from: String,
    pub to: String,
    pub duty: Option<String>,
    pub purpose: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateEdgePurposeRequest {
    pub purpose: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateChatDutyRequest {
    pub duty: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SendChatMessageRequest {
    pub text: String,
}

#[derive(Debug, Serialize)]
pub struct GraphErrorResponse {
    pub error: String,
    pub code: String,
}

/// Candidate for spawning a brand-new agent session via @-mention.
#[derive(Debug, Serialize)]
pub struct MentionAgent {
    pub name: String,
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon_id: Option<String>,
}

/// Candidate for sending a message to an existing reachable session
/// (caller has an outgoing edge to it).
#[derive(Debug, Serialize)]
pub struct MentionOutgoing {
    pub session_id: String,
    pub name: String,
    /// Underlying agent id (e.g. "claude", "codex") so the dropdown can
    /// render the correct agent icon.
    pub agent: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duty: Option<String>,
}

/// Candidate for replying to a session that is currently waiting on caller.
#[derive(Debug, Serialize)]
pub struct MentionPendingReply {
    pub session_id: String,
    pub name: String,
    pub agent: String,
    pub msg_id: String,
    pub body_preview: String,
}

#[derive(Debug, Serialize)]
pub struct MentionCandidatesResponse {
    pub agents: Vec<MentionAgent>,
    pub outgoing: Vec<MentionOutgoing>,
    pub pending_replies: Vec<MentionPendingReply>,
}

#[cfg(test)]
mod origin_ref_tests {
    use super::OriginRef;

    #[test]
    fn parse_absent_or_empty_is_none() {
        assert!(OriginRef::parse(None).unwrap().is_none());
        assert!(OriginRef::parse(Some("")).unwrap().is_none());
        assert!(OriginRef::parse(Some("   ")).unwrap().is_none());
    }

    #[test]
    fn parse_valid_yields_origin_key() {
        let o = OriginRef::parse(Some(
            r#"{"system":"eBay-Messages","id":"Ticket-8842","agent":"andy"}"#,
        ))
        .unwrap()
        .unwrap();
        // origin_key is lowercased + trimmed, derived server-side.
        assert_eq!(o.origin_key(), "ebay-messages:ticket-8842");
        assert_eq!(o.agent, "andy");
    }

    #[test]
    fn parse_missing_system_or_id_errors() {
        assert!(OriginRef::parse(Some(r#"{"system":"x"}"#)).is_err());
        assert!(OriginRef::parse(Some(r#"{"id":"y"}"#)).is_err());
        assert!(OriginRef::parse(Some(r#"{"system":" ","id":"y"}"#)).is_err());
    }

    #[test]
    fn parse_bad_json_errors() {
        assert!(OriginRef::parse(Some("not json")).is_err());
    }

    #[test]
    fn parse_oversized_errors() {
        let big = format!(r#"{{"system":"s","id":"{}"}}"#, "x".repeat(2000));
        assert!(OriginRef::parse(Some(&big)).is_err());
    }

    #[test]
    fn to_json_roundtrips_trimmed_fields() {
        let o = OriginRef::parse(Some(
            r#"{"system":" helpdesk ","id":" case-1 ","agent":" cody "}"#,
        ))
        .unwrap()
        .unwrap();
        let json = o.to_json();
        assert!(json.contains("\"helpdesk\""));
        assert!(json.contains("\"case-1\""));
        assert!(json.contains("\"cody\""));
    }
}
