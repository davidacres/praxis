//! Signal a whole process tree, not just its leader (`host/processTree.ts` port).
//!
//! On Unix the child is spawned as its own process-group leader (`process_group(0)`), and
//! the group is signalled. Windows has no process groups, so `taskkill /T` walks the tree.
//! Only a pid obtained from this process's own spawn is ever touched.

use tokio::process::Child;

/// Sends SIGTERM (or SIGKILL when `force`) to the group led by `pid`, falling back to the
/// child alone if the group cannot be signalled. On Windows, kills the tree outright.
#[cfg(unix)]
pub async fn signal_process_tree(child: &mut Child, pid: Option<u32>, force: bool) {
    use nix::errno::Errno;
    use nix::sys::signal::{Signal, killpg};
    use nix::unistd::Pid;

    let Some(pid) = pid else { return };
    let signal = if force {
        Signal::SIGKILL
    } else {
        Signal::SIGTERM
    };
    let group_signalled = i32::try_from(pid).is_ok_and(|raw| {
        matches!(
            killpg(Pid::from_raw(raw), signal),
            Ok(()) | Err(Errno::ESRCH)
        )
    });
    if !group_signalled {
        let _ = child.start_kill();
    }
}

#[cfg(not(unix))]
pub async fn signal_process_tree(child: &mut Child, pid: Option<u32>, _force: bool) {
    let _ = &child;
    let Some(pid) = pid else { return };
    let _ = tokio::process::Command::new("taskkill")
        .args(["/pid", &pid.to_string(), "/T", "/F"])
        .status()
        .await;
}
