//! Copies standard input to standard output byte for byte, then reports the byte count on standard error.
use std::io::{self, Write};
use std::process::ExitCode;

fn main() -> ExitCode {
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();
    match io::copy(&mut stdin, &mut stdout).and_then(|count| stdout.flush().map(|()| count)) {
        Ok(count) => {
            eprintln!("binary-echo: {count} bytes");
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("binary-echo: {error}");
            ExitCode::from(1)
        }
    }
}
