//! Run a single Automation through its registered handler.
//!
//! `builtin.task_prompt` keeps the existing Task/Chat pipeline:
//! 1. Insert an `automation_runs` row in `queued` state (caught by the
//!    startup-sweep if Grove dies before completion).
//! 2. Resolve target Task (existing → check; new → spawn worktree + row).
//! 3. Resolve target ChatSession (existing → check; new → DB row).
//! 4. `agent_graph::tools::ensure_target_handle` spawns the ACP subprocess
//!    if it isn't already running.
//! 5. Subscribe to the handle's broadcast **before** `queue_message` to
//!    avoid a race where the agent picks up the prompt before we have a
//!    listener attached.
//! 6. Queue the prompt with `Some("automation:<run_id>")` as the sender so
//!    we can identify our turn in the broadcast stream.
//! 7. Stamp `queued_at` on the run row.
//! 8. Fire-and-forget background task: wait for the matching `UserMessage`
//!    (that's when the agent picked up our prompt), accumulate `MessageChunk`
//!    text, then close out on the next `Complete` / `Error` / `SessionEnded`
//!    — or a 30-minute timeout. Truncate the accumulated text to 16 KB and
//!    persist as the final `agent_response`.
//!
//! Registered project handlers use the same Automation-owned dedicated ACP
//! driver. Handlers contribute only concurrency, business pre/post actions and
//! runtime bindings.

use std::time::Duration;

use chrono::Utc;
use tokio::sync::broadcast::error::RecvError;

use crate::acp::{AcpStartConfig, AcpUpdate, QueuedMessage};
use crate::agent_graph::tools::ensure_target_handle;
use crate::storage::{
    automations::{self, Automation, AutomationRun, RunClaim, TargetMode},
    config, installed_agents, tasks, workspace,
};

use super::{awarn, consumer, cron_util};

/// Cap on how long a single automation run waits for the agent's `Complete`
/// notification. The cron scheduler won't re-fire the same automation
/// before its next scheduled tick, so picking 30 min keeps long agent turns
/// (research, multi-tool workflows) alive without unbounded resource use.
const AGENT_COMPLETION_TIMEOUT: Duration = Duration::from_secs(30 * 60);
// `AcpUpdate::Complete` is emitted immediately before TaskChat drains its next
// queued prompt. Give that synchronous drain one scheduler window to surface a
// `QueueUpdate`/`UserMessage` before treating a project Run as truly settled.
// The biased receive below still observes an already-buffered follow-up even
// when the runtime is busy and this wall-clock deadline has elapsed.
const PROJECT_RUN_FOLLOWUP_GRACE: Duration = Duration::from_millis(100);

/// Grace window between "our entry vanished from the pending queue" and
/// "treat that as a user cancellation".
///
/// cmd_loop's normal end-of-turn drain emits `QueueUpdate { messages: [] }`
/// (with us already popped) *before* sending the Prompt command that
/// becomes a `UserMessage`. So "queue without us" can mean two things:
/// (a) cmd_loop is about to pump our prompt — a `UserMessage` is coming;
/// (b) the user clicked the trash icon on our queued prompt — no
/// `UserMessage` will ever arrive. We can't distinguish at the event
/// level, so we wait this long after seeing the disappearance. If a
/// matching `UserMessage` arrives within the window, it's case (a) and we
/// proceed; otherwise it's case (b) and we cancel.
///
/// 30s budget: between `pop_queue_front` and the agent's `UserMessage`,
/// cmd_loop performs up to three ACP roundtrips (SetSessionMode /
/// SetSessionModel / SetSessionConfigOption — see `acp/mod.rs:2620-2696`),
/// each of which can take several seconds against a slow agent backend.
/// Under-budgeting this kills legitimate runs as false cancels; over-
/// budgeting only matters for the true trash-click path (user waits up to
/// 30s for the cancelled badge), which is acceptable.
const DRAIN_GRACE: Duration = Duration::from_secs(30);

pub struct RunOutcome {
    pub run_id: String,
    pub status: String, // "queued" (will complete asynchronously) | "failed"
    pub error: Option<String>,
    pub resolved_task_id: Option<String>,
    pub resolved_chat_id: Option<String>,
}

impl RunOutcome {
    pub fn failed(error: impl Into<String>) -> Self {
        Self::failed_run("", error, None, None)
    }

    pub fn failed_run(
        run_id: impl Into<String>,
        error: impl Into<String>,
        resolved_task_id: Option<String>,
        resolved_chat_id: Option<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            status: "failed".to_string(),
            error: Some(error.into()),
            resolved_task_id,
            resolved_chat_id,
        }
    }

    pub fn queued(
        run_id: impl Into<String>,
        resolved_task_id: Option<String>,
        resolved_chat_id: Option<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            status: "queued".to_string(),
            error: None,
            resolved_task_id,
            resolved_chat_id,
        }
    }
}

fn now() -> i64 {
    Utc::now().timestamp()
}

/// Run one automation. Inserts the run row, resolves task + chat, queues the
/// prompt, and spawns a background task that updates the row to its terminal
/// state once the agent reports completion.
///
/// Returns once the prompt is queued (or once a pre-queue failure happens).
/// The eventual success/failure of the agent's actual work lands in the
/// `automation_runs` row asynchronously.
pub async fn run(automation: &Automation, trigger_kind: &str) -> RunOutcome {
    run_with_payload(automation, trigger_kind, None).await
}

pub async fn run_with_payload(
    automation: &Automation,
    trigger_kind: &str,
    trigger_payload: Option<serde_json::Value>,
) -> RunOutcome {
    if automation.handler_key != automations::TASK_PROMPT_HANDLER {
        let trigger = consumer::TriggerContext {
            kind: trigger_kind.to_string(),
            payload: trigger_payload,
        };
        return run_handler(automation, trigger).await;
    }

    let triggered_at = now();

    let run_id = match automations::insert_run(
        &automation.id,
        trigger_kind,
        trigger_payload.as_ref(),
        &automation.prompt,
        Some(agent_snapshot(automation))
            .filter(|s| !s.is_empty())
            .as_deref(),
        &automation.agent_config,
        &serde_json::json!({}),
        "task_chat",
        triggered_at,
    ) {
        Ok(id) => id,
        Err(e) => {
            // No row to write the error onto — surface to caller and bail.
            return RunOutcome {
                run_id: String::new(),
                status: "failed".to_string(),
                error: Some(format!("insert_run: {e}")),
                resolved_task_id: None,
                resolved_chat_id: None,
            };
        }
    };

    // 1. Resolve task ----------------------------------------------------
    let task_id = match resolve_task(automation) {
        Ok(id) => id,
        Err(e) => return fail(&run_id, "resolve_task", &e, None, None),
    };

    // 2. Resolve chat session -------------------------------------------
    let chat_id = match resolve_chat(automation, &task_id) {
        Ok(id) => id,
        Err(e) => return fail(&run_id, "resolve_session", &e, Some(&task_id), None),
    };

    // 2b. Stamp the resolved ids on the run row BEFORE any ACP work fires.
    //     The cancel handler reads `resolved_task_id` / `resolved_chat_id`
    //     to locate the ACP handle. If we deferred this until after
    //     send_prompt (as the original `mark_run_queued` did), a cancel
    //     fired in the meantime would mark the row `cancelled` but never
    //     dequeue / abort the ACP turn — the agent would keep running.
    //
    //     Treated as fatal: if this UPDATE fails (DB locked etc.) we abort
    //     before any ACP work, because *continuing* would put us back in
    //     the H2 bug class — DB row eventually cancelled while the agent
    //     happily processes the prompt because the cancel handler can't
    //     find the resolved ids.
    if let Err(e) = automations::mark_run_resolved(&run_id, &task_id, &chat_id) {
        return fail(
            &run_id,
            "stamp_resolved",
            &format!("mark_run_resolved: {e}"),
            Some(&task_id),
            Some(&chat_id),
        );
    }

    // 3. Ensure the ACP subprocess is up ---------------------------------
    let handle = match ensure_target_handle(&automation.project, &task_id, &chat_id).await {
        Ok(h) => h,
        Err(e) => {
            return fail(
                &run_id,
                "spawn_acp",
                &format!("ensure session: {e}"),
                Some(&task_id),
                Some(&chat_id),
            );
        }
    };

    // 4. Subscribe BEFORE handing the prompt to ACP. The agent could emit
    //    UserMessage + Complete within microseconds for a short prompt; if
    //    we subscribed after, those events go to no listener and the run
    //    sits on `queued` until the 30-min timeout.
    let rx = handle.subscribe();

    // 4b. Final pre-send cancel check. Narrows the post-`mark_run_resolved`
    //     window where a user-cancel could land *after* we stamped the
    //     ids but *before* we actually queued the prompt — without this,
    //     the row would be `cancelled` in the DB while the executor goes
    //     on to send_prompt and the agent runs. Still racy against a
    //     cancel that fires between this check and the send below, but
    //     that window is microseconds.
    if let Ok(Some(r)) = automations::get_run(&run_id) {
        if r.status != "queued" {
            return RunOutcome {
                run_id,
                status: r.status,
                error: None,
                resolved_task_id: Some(task_id),
                resolved_chat_id: Some(chat_id),
            };
        }
    }

    // 5. Idle vs busy — mirrors `agent_graph::tools::deliver_to_session`
    //    line 863-882: claim the busy slot with a CAS. If we win (session
    //    is idle), call send_prompt directly — the cmd_loop drains the
    //    pending queue only on `Complete`, so an idle session would hold
    //    a queued prompt forever (Bug 1). If we lose (something else is
    //    running), enqueue and let the end-of-turn drain pick it up.
    let snapshot = automation
        .agent_config
        .queued_config()
        .unwrap_or_else(|| handle.snapshot_config());
    let sender = format!("automation:{}", run_id);
    let claimed = handle
        .is_busy
        .compare_exchange(
            false,
            true,
            std::sync::atomic::Ordering::AcqRel,
            std::sync::atomic::Ordering::Acquire,
        )
        .is_ok();
    if claimed {
        let send_res = tokio::time::timeout(
            Duration::from_secs(10),
            handle.send_prompt(
                automation.prompt.clone(),
                Vec::new(),
                Some(sender.clone()),
                false,
                Some(snapshot),
            ),
        )
        .await;
        match send_res {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                handle
                    .is_busy
                    .store(false, std::sync::atomic::Ordering::Release);
                return fail(
                    &run_id,
                    "queue",
                    &format!("send_prompt: {e}"),
                    Some(&task_id),
                    Some(&chat_id),
                );
            }
            Err(_) => {
                handle
                    .is_busy
                    .store(false, std::sync::atomic::Ordering::Release);
                return fail(
                    &run_id,
                    "queue",
                    "send_prompt timeout (10s)",
                    Some(&task_id),
                    Some(&chat_id),
                );
            }
        }
    } else {
        let qmsg = QueuedMessage::new(
            automation.prompt.clone(),
            Vec::new(),
            Some(sender.clone()),
            false,
            Some(snapshot),
        );
        let updated = handle.queue_message(qmsg);
        handle.emit(AcpUpdate::QueueUpdate { messages: updated });
    }

    if let Err(e) = automations::mark_run_queued(&run_id, now()) {
        awarn!("mark_run_queued for {run_id}: {e}");
    }

    // 6. Fire-and-forget completion watcher.
    let run_id_for_task = run_id.clone();
    let sender_for_task = sender;
    tokio::spawn(async move {
        wait_for_completion(run_id_for_task, sender_for_task, rx).await;
    });

    RunOutcome {
        run_id,
        status: "queued".to_string(),
        error: None,
        resolved_task_id: Some(task_id),
        resolved_chat_id: Some(chat_id),
    }
}

async fn run_handler(automation: &Automation, trigger: consumer::TriggerContext) -> RunOutcome {
    let Some(handler) = consumer::get(&automation.handler_key) else {
        return RunOutcome::failed(format!(
            "unsupported Automation handler: {}",
            automation.handler_key
        ));
    };
    let single_flight =
        handler.concurrency_policy(automation) == consumer::ConcurrencyPolicy::SingleFlight;
    let agent_snapshot = automation
        .agent_config
        .agent_id()
        .map(installed_agents::canonicalize_agent_id);
    let run_id = match automations::claim_run(
        &automation.id,
        &trigger.kind,
        trigger.payload.as_ref(),
        &automation.prompt,
        agent_snapshot.as_deref(),
        &automation.agent_config,
        &serde_json::json!({}),
        "project_run",
        now(),
        single_flight,
    ) {
        Ok(RunClaim::Created(run_id)) => run_id,
        Ok(RunClaim::Existing(run)) => {
            return RunOutcome {
                run_id: run.id,
                status: run.status,
                error: None,
                resolved_task_id: run.resolved_task_id,
                resolved_chat_id: run.resolved_chat_id,
            }
        }
        Err(error) => return RunOutcome::failed(format!("claim Automation Run: {error}")),
    };
    let mut run = match automations::get_run(&run_id) {
        Ok(Some(run)) => run,
        Ok(None) => return RunOutcome::failed("claimed Automation Run disappeared"),
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "prepare",
                &error.to_string(),
            )
        }
    };
    let input = match handler.pre_action(consumer::PreActionContext {
        automation,
        run: &run,
        trigger: &trigger,
    }) {
        Ok(input) => input,
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "pre_action",
                &error.to_string(),
            )
        }
    };
    match automations::update_run_input(&run_id, &input) {
        Ok(true) => {}
        Ok(false) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "pre_action",
                "Automation Run stopped before preparation completed",
            )
        }
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "pre_action",
                &error.to_string(),
            )
        }
    }
    run = match automations::get_run(&run_id) {
        Ok(Some(run)) => run,
        Ok(None) => {
            return RunOutcome::failed_run(
                &run_id,
                "prepared Automation Run disappeared",
                None,
                None,
            )
        }
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "pre_action",
                &error.to_string(),
            )
        }
    };
    let bindings = match handler.runtime_bindings(consumer::RuntimeContext {
        automation,
        run: &run,
    }) {
        Ok(bindings) => bindings,
        Err(error) => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "runtime_bindings",
                &error.to_string(),
            )
        }
    };
    let agent_id = match run.agent_config_snapshot.agent_id() {
        Some(agent_id) if !agent_id.trim().is_empty() => {
            installed_agents::canonicalize_agent_id(agent_id)
        }
        _ => {
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "resolve_agent",
                "Automation requires agent_config.agent_id",
            )
        }
    };
    let Some(resolved_agent) = crate::acp::resolve_agent(&agent_id) else {
        return fail_handler(
            automation,
            handler.as_ref(),
            &run_id,
            "resolve_agent",
            &format!("Agent is not available: {agent_id}"),
        );
    };
    // `_memory` is only an ordinary TaskChat storage namespace. It is not a
    // Task entity and has no row in the tasks table.
    let task_id = tasks::MEMORY_TASK_ID.to_string();
    let chat_id = tasks::generate_chat_id();
    let chat = tasks::ChatSession {
        id: chat_id.clone(),
        title: format!(
            "{} · {}",
            automation.name,
            Utc::now().format("%Y-%m-%d %H:%M")
        ),
        agent: agent_id.clone(),
        acp_session_id: None,
        created_at: Utc::now(),
        duty: None,
        launch_mode: "acp".to_string(),
    };
    if let Err(error) = tasks::add_chat_session(&automation.project, &task_id, chat) {
        return fail_handler(
            automation,
            handler.as_ref(),
            &run_id,
            "resolve_session",
            &format!("create Automation Run chat: {error}"),
        );
    }
    let session_key = format!("{}:{}:{}", automation.project, task_id, chat_id);
    let start_config = AcpStartConfig {
        agent_command: resolved_agent.command,
        agent_name: resolved_agent.agent_name,
        agent_args: resolved_agent.args,
        working_dir: bindings.working_dir,
        env_vars: bindings.env_vars,
        project_key: automation.project.clone(),
        task_id: task_id.clone(),
        chat_id: Some(chat_id.clone()),
        // Use the ordinary TaskChat history/session.jsonl location. Runtime
        // bindings still provide Memory MCP/env configuration, but no second
        // persistence path is introduced for the same conversation.
        artifact_dir: None,
        additional_mcp_servers: bindings.additional_mcp_servers,
        mcp_server_policy: bindings.mcp_server_policy,
        agent_type: resolved_agent.agent_type,
        remote_url: resolved_agent.url,
        remote_auth: resolved_agent.auth_header,
        suppress_initial_connecting: true,
        import_session: false,
        persona_injection: None,
    };
    let (handle, rx) =
        match crate::acp::get_or_start_session(session_key.clone(), start_config).await {
            Ok(value) => value,
            Err(error) => {
                let _ = tasks::delete_chat_session(&automation.project, &task_id, &chat_id);
                return fail_handler(
                    automation,
                    handler.as_ref(),
                    &run_id,
                    "spawn_acp",
                    &format!("start Automation Agent Session: {error}"),
                );
            }
        };
    if let Err(error) = automations::mark_run_resolved(&run_id, &task_id, &chat_id) {
        let _ = handle.kill().await;
        let _ = tasks::delete_chat_session(&automation.project, &task_id, &chat_id);
        return fail_handler(
            automation,
            handler.as_ref(),
            &run_id,
            "stamp_resolved",
            &format!("mark_run_resolved: {error}"),
        );
    }
    if let Err(error) = automations::mark_run_running(&run_id) {
        let _ = handle.kill().await;
        return fail_handler(
            automation,
            handler.as_ref(),
            &run_id,
            "start_run",
            &error.to_string(),
        );
    }
    if !matches!(automations::get_run(&run_id), Ok(Some(ref active)) if active.status == "running")
    {
        let _ = handle.kill().await;
        handler
            .abort(consumer::AbortContext {
                automation,
                run: &run,
                reason: "Run stopped before Agent start",
            })
            .ok();
        return RunOutcome::queued(run_id, None, None);
    }
    let send_result = tokio::time::timeout(
        Duration::from_secs(10),
        handle.send_prompt(
            run.prompt_snapshot.clone(),
            Vec::new(),
            Some(format!("automation:{run_id}")),
            false,
            run.agent_config_snapshot.queued_config(),
        ),
    )
    .await;
    match send_result {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = handle.kill().await;
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "queue",
                &format!("send Automation prompt: {error}"),
            );
        }
        Err(_) => {
            let _ = handle.kill().await;
            return fail_handler(
                automation,
                handler.as_ref(),
                &run_id,
                "queue",
                "send Automation prompt timeout (10s)",
            );
        }
    }
    if let Err(error) = automations::mark_run_queued(&run_id, now()) {
        awarn!("mark_run_queued for {run_id}: {error}");
    }
    let task_automation = automation.clone();
    let task_run = run;
    let task_handler = handler;
    tokio::spawn(async move {
        wait_for_handler_completion(
            task_handler,
            task_automation,
            task_run,
            bindings.timeout,
            rx,
        )
        .await;
    });
    RunOutcome::queued(run_id, None, None)
}

fn fail_handler(
    automation: &Automation,
    handler: &dyn consumer::AutomationHandler,
    run_id: &str,
    phase: &str,
    error: &str,
) -> RunOutcome {
    if let Ok(Some(run)) = automations::get_run(run_id) {
        if let Err(abort_error) = handler.abort(consumer::AbortContext {
            automation,
            run: &run,
            reason: error,
        }) {
            awarn!("abort handler for {run_id}: {abort_error}");
        }
    }
    if let Err(mark_error) = automations::mark_run_failed(run_id, now(), phase, error) {
        awarn!("mark_run_failed for {run_id}: {mark_error}");
    }
    RunOutcome::failed_run(run_id, error, None, None)
}

async fn wait_for_handler_completion(
    handler: std::sync::Arc<dyn consumer::AutomationHandler>,
    automation: Automation,
    initial_run: AutomationRun,
    timeout: Duration,
    mut rx: tokio::sync::broadcast::Receiver<AcpUpdate>,
) {
    let mut response = String::new();
    let mut settle_after_complete: Option<tokio::time::Instant> = None;
    let terminal = tokio::time::timeout(timeout, async {
        loop {
            let received = match settle_after_complete {
                Some(deadline) => {
                    tokio::select! {
                        biased;
                        update = rx.recv() => Some(update),
                        _ = tokio::time::sleep_until(deadline) => None,
                    }
                }
                None => Some(rx.recv().await),
            };
            let Some(received) = received else {
                break Ok(());
            };
            match received {
                Ok(update) => {
                    automations::publish_run_event(
                        &automation.project,
                        &automation.id,
                        &initial_run.id,
                        &update,
                    );
                    // A product-level completion action (for example
                    // memory_mark_organization_finished) can finish the Run
                    // independently of the ordinary Chat Session. Stop only
                    // this Run watcher; never terminate the Session.
                    if matches!(
                        automations::get_run(&initial_run.id),
                        Ok(Some(ref run)) if run.status != "running"
                    ) {
                        break Ok(());
                    }
                    match update {
                        AcpUpdate::MessageChunk { text } => {
                            settle_after_complete = None;
                            response.push_str(&text);
                        }
                        AcpUpdate::Complete { .. } => {
                            let latest = automations::get_run(&initial_run.id)
                                .ok()
                                .flatten()
                                .unwrap_or_else(|| initial_run.clone());
                            match handler.completion_requested(consumer::RuntimeContext {
                                automation: &automation,
                                run: &latest,
                            }) {
                                Ok(true) => {
                                    settle_after_complete = Some(
                                        tokio::time::Instant::now() + PROJECT_RUN_FOLLOWUP_GRACE,
                                    );
                                }
                                Ok(false) => {
                                    // The Agent only finished one ordinary
                                    // Chat turn. Keep the Run watcher and the
                                    // Session alive for the user's next turn.
                                    settle_after_complete = None;
                                }
                                Err(error) => break Err(error.to_string()),
                            }
                        }
                        // A successful TaskChat auto-drain emits QueueUpdate
                        // directly after Complete, before the next UserMessage.
                        // Keep the Run alive so queued human guidance is not
                        // discarded when the first Agent turn finishes.
                        AcpUpdate::QueueUpdate { .. }
                        | AcpUpdate::UserMessage { .. }
                        | AcpUpdate::Busy { value: true } => {
                            settle_after_complete = None;
                        }
                        AcpUpdate::Error { message } => break Err(message),
                        AcpUpdate::SessionEnded => {
                            break Err(
                                "Automation Agent Session ended before completion".to_string()
                            )
                        }
                        _ => continue,
                    }
                }
                Err(RecvError::Lagged(skipped)) => {
                    awarn!(
                        "broadcast lagged for run {}: skipped {skipped} events",
                        initial_run.id
                    );
                }
                Err(RecvError::Closed) => {
                    break Err("Automation Agent Session closed before completion".to_string())
                }
            }
        }
    })
    .await;

    let latest = automations::get_run(&initial_run.id)
        .ok()
        .flatten()
        .unwrap_or(initial_run);
    match terminal {
        Ok(Ok(())) if latest.status == "running" => {
            let truncated =
                (!response.is_empty()).then(|| automations::truncate_agent_response(&response));
            let committed = automations::complete_consumer_run(&latest.id, now(), |tx| {
                let result = handler.post_action(
                    consumer::PostActionContext {
                        automation: &automation,
                        run: &latest,
                        agent_response: truncated.as_deref(),
                    },
                    tx,
                )?;
                tx.execute(
                    "UPDATE automation_runs SET agent_response = ?1 WHERE id = ?2",
                    rusqlite::params![truncated, latest.id],
                )?;
                Ok(((), result))
            });
            match committed {
                Ok(Some(())) => {
                    if let Err(error) = handler.after_commit(consumer::AfterCommitContext {
                        automation: &automation,
                        run: &latest,
                    }) {
                        awarn!("after_commit for run {}: {error}", latest.id);
                    }
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = handler.abort(consumer::AbortContext {
                        automation: &automation,
                        run: &latest,
                        reason: &error.to_string(),
                    });
                    let _ = automations::mark_run_failed(
                        &latest.id,
                        now(),
                        "post_action",
                        &error.to_string(),
                    );
                }
            }
        }
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = handler.abort(consumer::AbortContext {
                automation: &automation,
                run: &latest,
                reason: &error,
            });
            let phase = if error.starts_with("Prompt not sent") {
                "apply_agent_config"
            } else {
                "agent_run"
            };
            let _ = automations::mark_run_failed(&latest.id, now(), phase, &error);
        }
        Err(_) => {
            let _ = handler.abort(consumer::AbortContext {
                automation: &automation,
                run: &latest,
                reason: "Agent completion timeout",
            });
            let truncated =
                (!response.is_empty()).then(|| automations::truncate_agent_response(&response));
            let _ = automations::mark_run_timeout(&latest.id, now(), truncated.as_deref());
        }
    }
}

fn fail(
    run_id: &str,
    phase: &str,
    error: &str,
    task_id: Option<&str>,
    chat_id: Option<&str>,
) -> RunOutcome {
    if let Err(e) = automations::mark_run_failed(run_id, now(), phase, error) {
        awarn!("mark_run_failed for {run_id}: {e}");
    }
    RunOutcome {
        run_id: run_id.to_string(),
        status: "failed".to_string(),
        error: Some(error.to_string()),
        resolved_task_id: task_id.map(String::from),
        resolved_chat_id: chat_id.map(String::from),
    }
}

fn agent_snapshot(a: &Automation) -> String {
    match &a.session_mode {
        TargetMode::New => a
            .session_template
            .as_ref()
            .map(|t| t.agent.clone())
            .unwrap_or_default(),
        TargetMode::Existing => match (&a.chat_id, &a.task_id) {
            // Look up the chat's actual agent so the run row's snapshot
            // reflects the persona the user will see when they open the
            // session. Falls back to an empty string when the lookup fails
            // (chat or task deleted) — the run row's `agent_snapshot` is
            // for display only, so a missing value is acceptable.
            (Some(cid), Some(tid)) => tasks::get_chat_session(&a.project, tid, cid)
                .ok()
                .flatten()
                .map(|c| c.agent)
                .unwrap_or_default(),
            _ => String::new(),
        },
    }
}

/// Background task: watch the ACP broadcast for events tagged with our
/// `automation:<run_id>` sender, accumulate the agent's response text, and
/// land the run in its terminal state.
///
/// State machine inside:
///   waiting_for_pickup → streaming → done
///
/// In `waiting_for_pickup` we discard everything except our matching
/// `UserMessage` — that's the signal the agent dequeued our prompt and
/// started this turn. From then on we accumulate `MessageChunk.text` and
/// wait for `Complete` / `Error` / `SessionEnded`.
async fn wait_for_completion(
    run_id: String,
    sender: String,
    mut rx: tokio::sync::broadcast::Receiver<AcpUpdate>,
) {
    let mut started = false;
    let mut response = String::new();
    // True once we've observed our own sender in a `QueueUpdate`. Until
    // then, a `QueueUpdate` that doesn't include us is just "queue update
    // happening before we landed" (rare timing) — not a cancellation.
    let mut saw_self_in_queue = false;
    // When set, we've seen the queue *lose* our entry. If a matching
    // `UserMessage` arrives before this deadline we treat the drop as a
    // cmd_loop drain (case 1 in DRAIN_GRACE's doc). Otherwise we treat it
    // as a user cancellation.
    let mut drain_grace_until: Option<tokio::time::Instant> = None;

    let outcome = loop {
        let wait_for = match drain_grace_until {
            Some(deadline) => {
                let now = tokio::time::Instant::now();
                if now >= deadline {
                    break WatchOutcome::Cancelled("removed from pending queue".to_string());
                }
                deadline - now
            }
            None => AGENT_COMPLETION_TIMEOUT,
        };
        let recv = tokio::time::timeout(wait_for, rx.recv()).await;
        match recv {
            Err(_) => {
                // Either the long-poll timeout (no event in 30 min) or the
                // short drain-grace window expired. The branch above
                // already converts an expired grace into Cancelled, so
                // anything reaching here is the long timeout.
                if drain_grace_until.is_some() {
                    break WatchOutcome::Cancelled("removed from pending queue".to_string());
                }
                break WatchOutcome::Timeout(response);
            }
            Ok(Err(RecvError::Closed)) => {
                break WatchOutcome::Failed {
                    phase: "agent_run",
                    error: "ACP broadcast closed before completion".to_string(),
                    response,
                };
            }
            Ok(Err(RecvError::Lagged(n))) => {
                // Broadcast buffer (256 events) overran. We may have missed
                // the matching UserMessage or Complete. Log and keep trying
                // — the 30-min timeout is the ultimate floor.
                awarn!("broadcast lagged for run {run_id}: skipped {n} events");
                continue;
            }
            Ok(Ok(update)) => match update {
                AcpUpdate::UserMessage {
                    sender: Some(s), ..
                } if s == sender => {
                    started = true;
                    response.clear();
                    drain_grace_until = None;
                    // Promote queued → running so the UI shows "agent is
                    // actually working". Conditional UPDATE, so a cancel
                    // that beat us to the row stays cancelled.
                    if let Err(e) = automations::mark_run_running(&run_id) {
                        awarn!("mark_run_running for {run_id}: {e}");
                    }
                }
                // A *different* UserMessage after we started means the
                // cmd_loop has already moved on to the next prompt (manual
                // human message, or another automation queued behind us).
                // Our turn's `Complete` event was dropped on the floor —
                // most likely a broadcast lag we already logged above.
                // Close out with whatever we've accumulated so the chunks
                // belonging to the *next* turn don't pollute our snapshot.
                AcpUpdate::UserMessage { .. } if started => {
                    break WatchOutcome::Completed(std::mem::take(&mut response));
                }
                AcpUpdate::MessageChunk { text } if started => {
                    response.push_str(&text);
                }
                AcpUpdate::Complete { .. } if started => {
                    break WatchOutcome::Completed(response);
                }
                AcpUpdate::Error { message } if started => {
                    break WatchOutcome::Failed {
                        phase: "agent_run",
                        error: message,
                        response,
                    };
                }
                AcpUpdate::Error { message } if message.starts_with("Prompt not sent") => {
                    break WatchOutcome::Failed {
                        phase: "apply_agent_config",
                        error: message,
                        response,
                    };
                }
                AcpUpdate::SessionEnded if started => {
                    break WatchOutcome::Failed {
                        phase: "agent_run",
                        error: "ACP session ended before completion".to_string(),
                        response,
                    };
                }
                // SessionEnded before we ever picked up means the agent
                // died while a prior prompt was running. Surface that.
                AcpUpdate::SessionEnded => {
                    break WatchOutcome::Failed {
                        phase: "agent_run",
                        error: "ACP session ended before agent picked up the prompt".to_string(),
                        response,
                    };
                }
                // State sync with the chat UI: the user may trash-click
                // our queued message. But cmd_loop's normal end-of-turn
                // drain *also* removes us from the queue (and emits this
                // event) before sending the Prompt command that becomes
                // our UserMessage. The original implementation conflated
                // the two — every queue drain falsely cancelled the run.
                //
                // Now: we only act on a "queue lost us" event after we've
                // seen ourselves *in* a previous QueueUpdate (rules out the
                // first-event-before-we're-added race), and we wait
                // `DRAIN_GRACE` for the matching UserMessage before
                // declaring it a real cancellation.
                AcpUpdate::QueueUpdate { messages } if !started => {
                    let still_queued = messages
                        .iter()
                        .any(|m| m.sender.as_deref() == Some(&sender));
                    if still_queued {
                        saw_self_in_queue = true;
                        drain_grace_until = None;
                    } else if saw_self_in_queue && drain_grace_until.is_none() {
                        drain_grace_until = Some(tokio::time::Instant::now() + DRAIN_GRACE);
                    }
                }
                _ => continue,
            },
        }
    };

    persist(&run_id, outcome).await;
}

enum WatchOutcome {
    Completed(String),
    Failed {
        phase: &'static str,
        error: String,
        response: String,
    },
    Timeout(String),
    Cancelled(String),
}

async fn persist(run_id: &str, outcome: WatchOutcome) {
    let finished_at = now();
    let result = match outcome {
        WatchOutcome::Completed(text) => {
            let truncated = (!text.is_empty()).then(|| automations::truncate_agent_response(&text));
            automations::mark_run_completed(run_id, finished_at, truncated.as_deref())
        }
        WatchOutcome::Failed {
            phase,
            error,
            response: _response,
        } => automations::mark_run_failed(run_id, finished_at, phase, &error),
        WatchOutcome::Timeout(text) => {
            let truncated = (!text.is_empty()).then(|| automations::truncate_agent_response(&text));
            automations::mark_run_timeout(run_id, finished_at, truncated.as_deref())
        }
        WatchOutcome::Cancelled(reason) => {
            automations::mark_run_cancelled(run_id, finished_at, &reason)
        }
    };
    if let Err(e) = result {
        awarn!("persist outcome for {run_id}: {e}");
    }
}

// ── target resolution (unchanged) ───────────────────────────────────────

fn resolve_task(a: &Automation) -> Result<String, String> {
    match a.task_mode {
        TargetMode::Existing => {
            let task_id = a.task_id.clone().ok_or("existing mode requires task_id")?;
            tasks::get_task(&a.project, &task_id)
                .map_err(|e| e.to_string())?
                .ok_or("Task was deleted")?;
            Ok(task_id)
        }
        TargetMode::New => {
            let template = a
                .task_template
                .as_ref()
                .ok_or("new mode requires task_template")?;

            let project = workspace::load_project_by_hash(&a.project)
                .map_err(|e| e.to_string())?
                .ok_or("project not registered")?;

            let cfg = config::load_config();
            let session_type = cfg.default_session_type();
            let is_studio = project.project_type == workspace::ProjectType::Studio;

            let stamp = Utc::now().format("%Y%m%d-%H%M");
            let task_name = format!("{} ({})", template.name, stamp);

            let result = if is_studio {
                crate::operations::tasks::create_studio_task(
                    &project.path,
                    &a.project,
                    task_name,
                    &session_type,
                    "automation",
                )
            } else {
                let target = template
                    .target
                    .clone()
                    .or_else(|| crate::git::current_branch(&project.path).ok())
                    .unwrap_or_else(|| "main".to_string());
                let autolink = &cfg.auto_link.patterns;
                crate::operations::tasks::create_task(
                    &project.path,
                    &a.project,
                    task_name,
                    target,
                    &session_type,
                    autolink,
                    "automation",
                )
            }
            .map_err(|e| e.to_string())?;

            if let Some(notes) = template.notes.as_ref() {
                if !notes.is_empty() {
                    let _ = crate::storage::notes::save_notes(&a.project, &result.task.id, notes);
                }
            }

            Ok(result.task.id)
        }
    }
}

fn resolve_chat(a: &Automation, task_id: &str) -> Result<String, String> {
    match a.session_mode {
        TargetMode::Existing => {
            let chat_id = a.chat_id.clone().ok_or("existing mode requires chat_id")?;
            tasks::get_chat_session(&a.project, task_id, &chat_id)
                .map_err(|e| e.to_string())?
                .ok_or("Chat session was deleted")?;
            Ok(chat_id)
        }
        TargetMode::New => {
            let template = a
                .session_template
                .as_ref()
                .ok_or("new mode requires session_template")?;

            // Mirror the chat-create handler's title format
            // (`api/handlers/acp.rs::create_chat`, line ~1065): "{name}
            // 2026-05-25 14:30". No `Automation` prefix — the automation
            // chip on the card already conveys the source.
            let now = Utc::now();
            let stamp = now.format("%Y-%m-%d %H:%M");
            let title = template
                .title
                .clone()
                .unwrap_or_else(|| format!("{} {}", a.name, stamp));

            // Canonicalize the template agent id once. Legacy templates
            // (`claude`, `gh-copilot`, …) need to resolve to the post-v2.6
            // canonical row; we also persist the canonical id on the chat
            // so subsequent reads stay consistent.
            let canonical_agent = installed_agents::canonicalize_agent_id(&template.agent);

            // Derive launch_mode from selected channel + registry terminal_launch
            // (same rule as `acp::create_chat`). External + terminal_launch
            // present → "terminal"; everything else → "acp".
            let launch_mode = {
                let installed = installed_agents::get(&canonical_agent).ok().flatten();
                let is_terminal = installed
                    .as_ref()
                    .filter(|r| {
                        matches!(
                            r.selected_install_method,
                            installed_agents::InstallMethod::External
                        )
                    })
                    .and_then(|_| {
                        crate::storage::agent_registry::get()
                            .agents
                            .iter()
                            .find(|a| a.id == canonical_agent)
                            .and_then(|a| a.terminal_launch.clone())
                    })
                    .is_some();
                if is_terminal {
                    "terminal".to_string()
                } else {
                    "acp".to_string()
                }
            };

            let chat = tasks::ChatSession {
                id: tasks::generate_chat_id(),
                title,
                agent: canonical_agent,
                acp_session_id: None,
                created_at: now,
                duty: None,
                launch_mode,
            };
            tasks::add_chat_session(&a.project, task_id, chat.clone())
                .map_err(|e| e.to_string())?;
            Ok(chat.id)
        }
    }
}

/// Compute the next firing time for an automation. `None` when the cron
/// expression has no future occurrences (rare — usually a fixed past date).
/// Interpreted in the system local timezone — see `cron_util::next_unix`.
pub fn advance_next_run(a: &Automation) -> Option<i64> {
    cron_util::next_unix(&a.schedule_cron).ok().flatten()
}
