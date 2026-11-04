//! The module's pinned demonstration program, `rust-bridge-demo`.
//!
//!   rust-bridge-demo [args...] [--exit <n>]   prints its arguments and exits with <n>
//!   rust-bridge-demo identity [--prompt]      prints its Linux identity, directory and terminals as JSON
//!   rust-bridge-demo echo                      copies standard input to standard output byte for byte
use std::io::{self, IsTerminal, Write};
use std::process::ExitCode;

fn hello(args: &[String]) -> ExitCode {
    println!("hello from rust wasm: {args:?}");
    let status = args
        .iter()
        .position(|arg| arg == "--exit")
        .and_then(|index| args.get(index + 1))
        .and_then(|value| value.parse::<u8>().ok())
        .unwrap_or(0);
    ExitCode::from(status)
}

fn json(text: &str) -> String {
    let mut out = String::from("\"");
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            control if control.is_control() => {
                out.push_str(&format!("\\u{:04x}", u32::from(control)))
            }
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

fn identity(prompt: bool) -> ExitCode {
    let info = match oxidevm_bridge::process::info() {
        Ok(info) => info,
        Err(error) => {
            eprintln!("rust-bridge-demo: {error}");
            return ExitCode::from(1);
        }
    };
    let bridge_cwd = oxidevm_bridge::process::cwd()
        .map_or_else(|error| error.to_string(), |path| path.display().to_string());
    let std_cwd = std::env::current_dir()
        .map_or_else(|error| error.to_string(), |path| path.display().to_string());
    let parent = info
        .parent
        .map_or_else(|| "null".to_string(), |pid| pid.to_string());
    println!(
        "{{\"pid\":{},\"parent\":{parent},\"uid\":{},\"gid\":{},\"bridgeCwd\":{},\"stdCwd\":{},\"terminals\":[{},{},{}]}}",
        info.pid,
        info.uid,
        info.gid,
        json(&bridge_cwd),
        json(&std_cwd),
        io::stdin().is_terminal(),
        io::stdout().is_terminal(),
        io::stderr().is_terminal()
    );
    if prompt && io::stdin().is_terminal() {
        eprint!("prompt> ");
    }
    ExitCode::SUCCESS
}

fn echo() -> ExitCode {
    let mut stdout = io::stdout().lock();
    match io::copy(&mut io::stdin().lock(), &mut stdout)
        .and_then(|count| stdout.flush().map(|()| count))
    {
        Ok(count) => {
            eprintln!("rust-bridge-demo: {count} bytes");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("rust-bridge-demo: {error}");
            ExitCode::from(1)
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("identity") => identity(args.get(2).is_some_and(|arg| arg == "--prompt")),
        Some("echo") => echo(),
        _ => hello(&args),
    }
}
