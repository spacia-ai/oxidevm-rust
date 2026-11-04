//! Prints a greeting with its arguments and exits with the status named by `--exit <n>` (default 0).
use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    println!("hello from rust wasm: {args:?}");
    let status = args
        .iter()
        .position(|arg| arg == "--exit")
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or(0);
    ExitCode::from(status)
}
