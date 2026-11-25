//! Child processes that never flash a console window.
//!
//! Praxis is a GUI program on Windows. Every console program it starts (`git`, `node`, an agent
//! CLI) would otherwise get a console window of its own: a black terminal that flashes up, or stays
//! open, for each spawn. `CREATE_NO_WINDOW` stops that without touching the child's piped stdio.
//! On other platforms this does nothing.

/// `CREATE_NO_WINDOW` from the Win32 process creation flags.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// A command that can be told not to open a console window.
pub trait NoConsole {
    fn no_console(&mut self) -> &mut Self;
}

impl NoConsole for std::process::Command {
    fn no_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

impl NoConsole for tokio::process::Command {
    fn no_console(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            self.creation_flags(CREATE_NO_WINDOW);
        }
        self
    }
}

/// Returns `command` set to start without a console window; wrap a `Command::new(..)` in it.
pub fn quiet<C: NoConsole>(mut command: C) -> C {
    command.no_console();
    command
}
