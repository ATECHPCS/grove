//! Provider layer — pure upstream quota API callers.
//!
//! Each module knows one thing: given an API token, call the upstream quota
//! endpoint and return an `AgentUsage`. No auth resolution, no config parsing.

pub mod claude;
pub mod codex;
pub mod copilot;
pub mod gemini;
pub mod kimi;
pub mod minimax;
pub mod synthetic;
pub mod zai;
