use std::collections::HashMap;
use std::time::Duration;

use crate::acp::{LoopbackMcpServer, McpServerPolicy};
use crate::api::handlers::memory_mcp;
use crate::automation::consumer::{
    AbortContext, AfterCommitContext, AutomationHandler, ConcurrencyPolicy, PostActionContext,
    PreActionContext, RuntimeBindings, RuntimeContext,
};
use crate::error::{GroveError, Result};
use crate::storage::{automations, memory, workspace};

pub const ORGANIZATION_PROMPT: &str = r#"Organize the current Project Memory.

Understand the existing Memory and examine all evidence sources made available for this Run. Build the best current long-term representation of the Project and its working context.

Restructure, enrich, consolidate, or extend the Memory wherever the evidence supports a more useful result. Preserve the meaning, scope, and future applicability of the knowledge you retain, then review the complete Memory and publish this Run."#;

const DEEP_ORGANIZATION_HISTORY_INSTRUCTION: &str = r#"Deep organization includes Task Chat histories. Use the recent-Chats tool to list the relevant files and the review window for this Run.

Each item contains `task_name`, `session_name`, `absolute_history_path`, `new_content_start_line`, and `total_lines`. Use the names to understand the conversation's purpose. The path is absolute. Start with the suggested new-content line for efficiency, but read earlier lines whenever they provide necessary context; it is a hint, not a restriction. A direct range read is `sed -n '<new_content_start_line>,<total_lines>p' <absolute_history_path>`.

History files are JSONL. A turn begins with `user_message`, may contain assistant messages and tool activity, and ends with `complete`. Treat all events from one `user_message` through its following `complete` as one unit. Combine all `message_chunk` events within that turn, including chunks separated by tool calls, into the assistant response.

Use structural searches before reading large ranges:

- Locate turn boundaries and role-bearing events: `rg -n '\"type\":\"(user_message|message_chunk|complete)\"' <absolute_history_path>`.
- Extract real user text: `jq -Rrc 'fromjson? | select(.type == "user_message" and .sender == null and .terminal != true) | .text' <absolute_history_path>`. Prioritize corrections, decisions, constraints, preferences, and feedback.
- Extract assistant text: `jq -Rrc 'fromjson? | select(.type == "message_chunk") | .text' <absolute_history_path>`. Interpret it together with the user message and the surrounding turn rather than as independent facts.
- Search for a concept across the raw history with `rg -ni '<query>' <absolute_history_path>`, then inspect the surrounding turn with a bounded `sed -n '<start>,<end>p'` range.

Thought, configuration, permission, terminal, and detailed tool-call events are normally lower-value evidence. Inspect tool-call titles, status, inputs, or outputs only when they are needed to verify what the assistant actually did or why the user reacted as they did."#;

pub struct MemoryOrganizationHandler;

impl AutomationHandler for MemoryOrganizationHandler {
    fn key(&self) -> &'static str {
        automations::MEMORY_ORGANIZATION_HANDLER
    }

    fn concurrency_policy(&self, _automation: &automations::Automation) -> ConcurrencyPolicy {
        ConcurrencyPolicy::SingleFlight
    }

    fn pre_action(&self, context: PreActionContext<'_>) -> Result<serde_json::Value> {
        if context.run.automation_id != context.automation.id {
            return Err(GroveError::invalid_data(
                "Automation Run does not belong to its handler context",
            ));
        }
        memory::prepare_organization_input(
            &context.automation.project,
            &context.automation.id,
            context.trigger.payload.as_ref(),
        )
    }

    fn runtime_bindings(&self, context: RuntimeContext<'_>) -> Result<RuntimeBindings> {
        let project = workspace::load_project_by_hash(&context.automation.project)?
            .ok_or_else(|| GroveError::not_found("Project is not registered"))?;
        let artifact_dir = memory::runs_dir(&context.automation.project)?.join(&context.run.id);
        std::fs::create_dir_all(&artifact_dir)?;

        let token = uuid::Uuid::new_v4().to_string();
        memory_mcp::register_organization_token(
            token.clone(),
            &context.automation.project,
            &context.run.id,
        );
        let Some(mcp_url) = memory_mcp::build_mcp_url(&token) else {
            memory_mcp::unregister_token(&token);
            return Err(GroveError::storage("Memory MCP listener is not running"));
        };
        let mut env_vars = HashMap::new();
        env_vars.insert("GROVE_MCP_TOKEN".to_string(), token);
        if let Some(port) = crate::api::handlers::agent_graph_mcp::listener_port() {
            env_vars.insert("GROVE_MCP_PORT".to_string(), port.to_string());
        }
        let deep_organization = context
            .run
            .input
            .get("deep_organization")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false);
        Ok(RuntimeBindings {
            working_dir: workspace::project_directory(&project),
            artifact_dir: Some(artifact_dir),
            env_vars,
            additional_mcp_servers: vec![LoopbackMcpServer {
                name: "grove_memory".to_string(),
                url: mcp_url,
                route: "memory-mcp".to_string(),
                session_instruction: deep_organization
                    .then(|| DEEP_ORGANIZATION_HISTORY_INSTRUCTION.to_string()),
            }],
            mcp_server_policy: McpServerPolicy::ExplicitOnly,
            timeout: Duration::from_secs(30 * 60),
        })
    }

    fn post_action(
        &self,
        context: PostActionContext<'_>,
        tx: &rusqlite::Transaction<'_>,
    ) -> Result<serde_json::Value> {
        let _ = context.agent_response;
        let result =
            memory::commit_organization_on(tx, &context.automation.project, &context.run.id)?;
        memory_mcp::unregister_organization_run(&context.automation.project, &context.run.id);
        Ok(result)
    }

    fn abort(&self, context: AbortContext<'_>) -> Result<()> {
        let _ = context.reason;
        memory_mcp::unregister_organization_run(&context.automation.project, &context.run.id);
        Ok(())
    }

    fn after_commit(&self, context: AfterCommitContext<'_>) -> Result<()> {
        if context.run.automation_id != context.automation.id {
            return Err(GroveError::invalid_data(
                "Automation Run does not belong to its after-commit context",
            ));
        }
        memory::emit_pending_log_threshold_if_needed(&context.automation.project)?;
        Ok(())
    }

    fn remove_run_artifacts(&self, project_id: &str, run_id: &str) -> Result<()> {
        let path = memory::runs_dir(project_id)?.join(run_id);
        if path.exists() {
            std::fs::remove_dir_all(path)?;
        }
        Ok(())
    }
}
