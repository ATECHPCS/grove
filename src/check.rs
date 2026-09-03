//! 环境检查

use std::path::{Path, PathBuf};
use std::process::Command;

/// Resolve a command name to an absolute executable path on PATH.
///
/// Walks `PATH` directly and respects `PATHEXT` on Windows. Returns the first
/// matching path, or `None` if nothing on PATH is executable. Avoids spawning
/// `which` / `where.exe` per check (Windows process creation is slow, and
/// `where.exe` writes noise to stderr when not found).
///
/// On Windows this is what callers should use *before* `Command::new(...)` for
/// any program that may be installed as a shim (`.cmd`/`.bat`, e.g. npm-global
/// CLIs). `CreateProcessW` does NOT search PATHEXT — passing a bare `"opencode"`
/// will fail even if `opencode.cmd` is on PATH.
pub fn resolve_program(cmd: &str) -> Option<PathBuf> {
    // If the caller already gave us an absolute or path-qualified name, just
    // verify it's executable and return as-is. Don't try to re-search PATH.
    if Path::new(cmd).components().count() > 1 {
        return is_executable_file(Path::new(cmd)).then(|| PathBuf::from(cmd));
    }

    let path_var = std::env::var_os("PATH")?;

    #[cfg(windows)]
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string())
        .split(';')
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect();
    #[cfg(not(windows))]
    let exts: Vec<String> = vec![String::new()];

    // On Windows, only accept a literal name with extension if that extension
    // is in PATHEXT — otherwise `resolve_program("foo.txt")` would falsely match
    // a text file in PATH. On Unix, any literal name is fine.
    #[cfg(windows)]
    let literal_ok = Path::new(cmd)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let dot_e = format!(".{}", e);
            exts.iter().any(|p| p.eq_ignore_ascii_case(&dot_e))
        })
        .unwrap_or(false);
    #[cfg(not(windows))]
    let literal_ok = true;

    for dir in std::env::split_paths(&path_var) {
        if literal_ok {
            let candidate = dir.join(cmd);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
        #[cfg(windows)]
        {
            for ext in &exts {
                let candidate = dir.join(format!("{}{}", cmd, ext));
                if is_executable_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
        #[cfg(not(windows))]
        {
            // exts is [""] on Unix; literal_ok branch above already covered it.
            let _ = &exts;
        }
    }
    None
}

/// Check if a command exists on PATH. Thin wrapper around [`resolve_program`].
pub fn command_exists(cmd: &str) -> bool {
    resolve_program(cmd).is_some()
}

/// On Unix, also requires at least one execute bit. On Windows, PATHEXT entries
/// are considered executable by virtue of their extension — `is_file()` is enough.
fn is_executable_file(path: &Path) -> bool {
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return false,
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

pub struct CheckResult {
    pub ok: bool,
    pub errors: Vec<String>,
}

fn missing_tui_multiplexer_error(tmux_ok: bool, zellij_ok: bool) -> Option<&'static str> {
    (!tmux_ok && !zellij_ok)
        .then_some("TUI mode requires tmux or zellij. Please install at least one.")
}

/// Check dependencies required specifically by the TUI.
///
/// Other Grove surfaces (Web, GUI, MCP, ACP) do not require a terminal
/// multiplexer, so this check must only be called from the TUI entry point.
pub fn check_tui_environment() -> CheckResult {
    let mut errors = Vec::new();

    // 检查 git
    if !check_git() {
        errors.push("git is not installed. Please install git first.".to_string());
    }

    // TUI sessions require at least one supported terminal multiplexer.
    let tmux_ok = check_tmux_available();
    let zellij_ok = check_zellij_available();

    if let Some(error) = missing_tui_multiplexer_error(tmux_ok, zellij_ok) {
        errors.push(error.to_string());
    }

    // 如果 tmux 可用但版本太旧，给出警告（非致命）
    if tmux_ok {
        if let TmuxCheck::VersionTooOld(ver) = check_tmux() {
            errors.push(format!(
                "tmux version {} is too old. Please upgrade to tmux 3.0+ for tmux support.",
                ver
            ));
        }
    }

    CheckResult {
        ok: errors.is_empty(),
        errors,
    }
}

fn check_git() -> bool {
    Command::new("git")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if fzf is installed (for grove fp command)
pub fn check_fzf() -> bool {
    Command::new("fzf")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if tmux is installed (any version)
pub fn check_tmux_available() -> bool {
    // 测试模式：通过环境变量模拟 tmux 不存在
    // 使用方法: GROVE_TEST_NO_TMUX=1 cargo run
    if std::env::var("GROVE_TEST_NO_TMUX").is_ok() {
        return false;
    }

    Command::new("tmux")
        .arg("-V")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Check if zellij is installed
pub fn check_zellij_available() -> bool {
    // 测试模式：通过环境变量模拟 zellij 不存在
    // 使用方法: GROVE_TEST_NO_ZELLIJ=1 cargo run
    if std::env::var("GROVE_TEST_NO_ZELLIJ").is_ok() {
        return false;
    }

    Command::new("zellij")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

enum TmuxCheck {
    Ok,
    NotInstalled,
    VersionTooOld(String),
}

fn check_tmux() -> TmuxCheck {
    let output = match Command::new("tmux").arg("-V").output() {
        Ok(o) if o.status.success() => o,
        _ => return TmuxCheck::NotInstalled,
    };

    let version_str = String::from_utf8_lossy(&output.stdout);
    // "tmux 3.4" -> parse "3.4"
    let version = version_str
        .trim()
        .strip_prefix("tmux ")
        .unwrap_or("")
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .unwrap_or("");

    let major: u32 = version
        .split('.')
        .next()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);

    if major >= 3 {
        TmuxCheck::Ok
    } else {
        TmuxCheck::VersionTooOld(version.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::missing_tui_multiplexer_error;

    #[test]
    fn tui_requires_at_least_one_multiplexer() {
        assert!(missing_tui_multiplexer_error(false, false).is_some());
        assert!(missing_tui_multiplexer_error(true, false).is_none());
        assert!(missing_tui_multiplexer_error(false, true).is_none());
        assert!(missing_tui_multiplexer_error(true, true).is_none());
    }
}
