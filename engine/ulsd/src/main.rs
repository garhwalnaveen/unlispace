//! `ulsd` / `uls` multicall binary. Invoked as `uls` (or with a CLI subcommand) it is the CLI.

mod cli;
mod nfs;

use std::ffi::OsStr;
use std::path::Path;

use clap::Parser;

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "warn".into()))
        .with_writer(std::io::stderr)
        .init();

    // Multicall: the name we were invoked as decides the displayed command name. The command
    // set is the same for `ulsd` and `uls`; the daemon-only behaviour in M0 is `mount`.
    let argv0 = std::env::args_os().next().unwrap_or_default();
    let invoked_as = Path::new(&argv0).file_name().unwrap_or(OsStr::new("ulsd")).to_string_lossy().into_owned();
    let name: &'static str = if invoked_as == "uls" { "uls" } else { "ulsd" };
    let mut args: Vec<std::ffi::OsString> = std::env::args_os().collect();
    if let Some(a0) = args.first_mut() {
        *a0 = name.into();
    }
    let parsed = cli::Cli::parse_from(args);
    match cli::run(parsed).await {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{name}: {e:#}");
            std::process::ExitCode::from(exit_code(&e))
        }
    }
}

/// 2 for "your request was rejected" (conflicts, preconditions, not found), 1 otherwise.
fn exit_code(e: &anyhow::Error) -> u8 {
    use uls_client::Error as E;
    match e.downcast_ref::<E>() {
        Some(E::PreconditionFailed { .. } | E::NotFound { .. } | E::DriveExists) => 2,
        _ => 1,
    }
}
