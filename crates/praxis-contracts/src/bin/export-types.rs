//! Binary target that exports `crates/praxis-contracts` types into
//! `packages/core/src/host/ipcContracts.ts` (or verifies no drift when `--check` is passed).

use std::{env, path::PathBuf, process::ExitCode};

use praxis_contracts::sync_ipc_contracts_file;

fn default_ipc_contracts_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir
        .parent()
        .and_then(|crates_dir| crates_dir.parent())
        .expect("workspace root")
        .join("packages/core/src/host/ipcContracts.ts")
}

fn main() -> ExitCode {
    let args: Vec<String> = env::args().skip(1).collect();
    let check_only = args.iter().any(|arg| arg == "--check");
    let custom_path = args
        .iter()
        .find(|arg| !arg.starts_with("--"))
        .map(PathBuf::from);
    let target_path = custom_path.unwrap_or_else(default_ipc_contracts_path);

    match sync_ipc_contracts_file(&target_path, check_only) {
        Ok(changed) => {
            if check_only {
                println!("praxis-contracts: {} is up to date.", target_path.display());
            } else if changed {
                println!("praxis-contracts: updated {}.", target_path.display());
            } else {
                println!(
                    "praxis-contracts: {} already up to date.",
                    target_path.display()
                );
            }
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("praxis-contracts error: {err}");
            ExitCode::FAILURE
        }
    }
}
