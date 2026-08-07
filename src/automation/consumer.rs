//! Registry for project-level Automation handlers.
//!
//! Automations owns execution: Run creation, concurrency, ACP lifecycle,
//! cancellation, timeout and terminal state. A handler contributes only the
//! business work around that execution.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use once_cell::sync::Lazy;

use crate::acp::{LoopbackMcpServer, McpServerPolicy};
use crate::error::Result;
use crate::storage::automations::{Automation, AutomationRun};

#[derive(Debug, Clone)]
pub struct TriggerContext {
    pub kind: String,
    pub payload: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConcurrencyPolicy {
    AllowParallel,
    SingleFlight,
}

pub struct PreActionContext<'a> {
    pub automation: &'a Automation,
    pub run: &'a AutomationRun,
    pub trigger: &'a TriggerContext,
}

#[derive(Debug)]
pub struct RuntimeContext<'a> {
    pub automation: &'a Automation,
    pub run: &'a AutomationRun,
}

#[derive(Debug)]
pub struct RuntimeBindings {
    pub working_dir: PathBuf,
    pub artifact_dir: Option<PathBuf>,
    pub env_vars: HashMap<String, String>,
    pub additional_mcp_servers: Vec<LoopbackMcpServer>,
    pub mcp_server_policy: McpServerPolicy,
    pub timeout: Duration,
}

pub struct PostActionContext<'a> {
    pub automation: &'a Automation,
    pub run: &'a AutomationRun,
    pub agent_response: Option<&'a str>,
}

pub struct AbortContext<'a> {
    pub automation: &'a Automation,
    pub run: &'a AutomationRun,
    pub reason: &'a str,
}

pub struct AfterCommitContext<'a> {
    pub automation: &'a Automation,
    pub run: &'a AutomationRun,
}

pub trait AutomationHandler: Send + Sync {
    fn key(&self) -> &'static str;

    fn concurrency_policy(&self, _automation: &Automation) -> ConcurrencyPolicy {
        ConcurrencyPolicy::AllowParallel
    }

    /// Prepare business input after Automation has atomically claimed a Run,
    /// but before any Agent Session is created.
    fn pre_action(&self, _context: PreActionContext<'_>) -> Result<serde_json::Value> {
        Ok(serde_json::json!({}))
    }

    /// Supply runtime-only bindings. Prompt and Agent configuration always
    /// come from the Automation Run snapshot and are intentionally absent.
    fn runtime_bindings(&self, context: RuntimeContext<'_>) -> Result<RuntimeBindings>;

    /// Commit business output inside the same SQLite transaction that marks
    /// the Automation Run successful.
    fn post_action(
        &self,
        context: PostActionContext<'_>,
        tx: &rusqlite::Transaction<'_>,
    ) -> Result<serde_json::Value>;

    /// Release handler-owned runtime resources after a failed, timed-out or
    /// cancelled Agent execution. Durable Run artifacts are retained.
    fn abort(&self, _context: AbortContext<'_>) -> Result<()> {
        Ok(())
    }

    /// Run non-transactional follow-up work only after the Run and business
    /// output have committed successfully. Failure here must not roll back or
    /// reclassify the completed Run.
    fn after_commit(&self, _context: AfterCommitContext<'_>) -> Result<()> {
        Ok(())
    }

    fn remove_run_artifacts(&self, _project_id: &str, _run_id: &str) -> Result<()> {
        Ok(())
    }
}

static HANDLERS: Lazy<RwLock<HashMap<String, Arc<dyn AutomationHandler>>>> =
    Lazy::new(|| RwLock::new(HashMap::new()));

/// Registration is idempotent by key so each API bootstrap path can safely
/// install built-in handlers before the scheduler or trigger endpoints run.
pub fn register(handler: Arc<dyn AutomationHandler>) {
    HANDLERS
        .write()
        .expect("Automation handler registry poisoned")
        .insert(handler.key().to_string(), handler);
}

pub fn get(handler_key: &str) -> Option<Arc<dyn AutomationHandler>> {
    HANDLERS
        .read()
        .expect("Automation handler registry poisoned")
        .get(handler_key)
        .cloned()
}

pub fn remove_run_artifacts(handler_key: &str, project_id: &str, run_id: &str) -> Result<()> {
    if let Some(handler) = get(handler_key) {
        handler.remove_run_artifacts(project_id, run_id)?;
    }
    Ok(())
}
