//! Plugin runtime support — launching a plugin's node processes (MCP server,
//! backend) under the Node Permission Model. See [`runtime`].

pub mod backend;
pub mod events;
pub mod exec;
pub mod radio_bridge;
pub mod runtime;
