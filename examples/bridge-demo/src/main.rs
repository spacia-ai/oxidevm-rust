//! The module's pinned demonstration program, `rust-bridge-demo`.
//!
//!   rust-bridge-demo [args...] [--exit <n>]   prints its arguments and exits with <n>
//!   rust-bridge-demo identity [--prompt]      prints its Linux identity, directory and terminals as JSON
//!   rust-bridge-demo echo                      copies standard input to standard output byte for byte
//!   rust-bridge-demo run <program> [args...]  runs a native program with this program's stdin as its input, prints
//!                                              its output and exits with its status (100 + signal when killed)
//!   rust-bridge-demo connect tcp <host> <port> | tls <host> <port> | unix <path>
//!                                              sends standard input, half-closes, prints every reply byte
//!   rust-bridge-demo summarize <orders.csv> <summary.csv>
//!                                              totals per country (order_id,country,total), written atomically, then
//!                                              compressed by native gzip and verified by decompressing it natively
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

fn run(args: &[String]) -> ExitCode {
    use std::io::Read;
    let Some((program, rest)) = args.split_first() else {
        eprintln!("usage: rust-bridge-demo run <program> [args...]");
        return ExitCode::from(2);
    };
    let mut input = Vec::new();
    if io::stdin().read_to_end(&mut input).is_err() {
        eprintln!("rust-bridge-demo: cannot read standard input");
        return ExitCode::from(1);
    }
    let mut command = oxidevm_bridge::process::Command::new(program.as_str());
    command.args(rest.iter().cloned()).input(input);
    match command.output() {
        Ok(output) => {
            let _ = io::stdout().write_all(&output.stdout);
            let _ = io::stderr().write_all(&output.stderr);
            eprintln!("rust-bridge-demo: child {} {:?}", output.pid, output.status);
            match output.status {
                oxidevm_bridge::process::ExitStatus::Exited(code) => ExitCode::from(code.min(119)),
                oxidevm_bridge::process::ExitStatus::Signaled(signal) => {
                    ExitCode::from(100 + signal.min(19))
                }
            }
        }
        Err(error) => {
            eprintln!("rust-bridge-demo: {error}");
            ExitCode::from(1)
        }
    }
}

fn connect(args: &[String]) -> ExitCode {
    use std::io::Read;
    use std::net::Shutdown;
    let parts: Vec<&str> = args.iter().map(String::as_str).collect();
    let mut input = Vec::new();
    if io::stdin().read_to_end(&mut input).is_err() {
        return ExitCode::from(1);
    }
    let exchange = |stream: &mut dyn ReadWrite,
                    shutdown: &dyn Fn() -> io::Result<()>|
     -> io::Result<Vec<u8>> {
        stream.write_all(&input)?;
        shutdown()?;
        let mut reply = Vec::new();
        stream.read_to_end(&mut reply)?;
        Ok(reply)
    };
    let result = match parts.as_slice() {
        ["tcp" | "tls", host, port] => match port.parse::<u16>() {
            Ok(port) => {
                let opened = if parts.first() == Some(&"tls") {
                    oxidevm_bridge::net::TcpStream::connect_tls(host, port, &[])
                } else {
                    oxidevm_bridge::net::TcpStream::connect(host, port)
                };
                opened.and_then(|stream| {
                    let shared = std::cell::RefCell::new(stream);
                    let shutdown = || shared.borrow().shutdown(Shutdown::Write);
                    exchange(&mut Shared(&shared), &shutdown)
                })
            }
            Err(_) => Err(io::Error::new(io::ErrorKind::InvalidInput, "bad port")),
        },
        ["unix", path] => oxidevm_bridge::net::UnixStream::connect(path).and_then(|stream| {
            let shared = std::cell::RefCell::new(stream);
            let shutdown = || shared.borrow().shutdown(Shutdown::Write);
            exchange(&mut Shared(&shared), &shutdown)
        }),
        _ => {
            eprintln!(
                "usage: rust-bridge-demo connect tcp <host> <port> | tls <host> <port> | unix <path>"
            );
            return ExitCode::from(2);
        }
    };
    match result {
        Ok(reply) => {
            let _ = io::stdout().write_all(&reply);
            ExitCode::SUCCESS
        }
        Err(error) => {
            eprintln!("rust-bridge-demo: {:?}: {error}", error.kind());
            ExitCode::from(1)
        }
    }
}

fn summarize(args: &[String]) -> ExitCode {
    let (Some(input), Some(output)) = (args.first(), args.get(1)) else {
        eprintln!("usage: rust-bridge-demo summarize <orders.csv> <summary.csv>");
        return ExitCode::from(2);
    };
    match summarize_files(input, output) {
        Ok(line) => {
            println!("{line}");
            ExitCode::SUCCESS
        }
        Err(message) => {
            eprintln!("rust-bridge-demo: {message}");
            ExitCode::from(1)
        }
    }
}

fn summarize_files(input: &str, output: &str) -> Result<String, String> {
    use oxidevm_bridge::process::{Command, ExitStatus};
    let text =
        std::fs::read_to_string(input).map_err(|error| format!("cannot read {input}: {error}"))?;
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("order_id,country,total") {
        return Err(format!(
            "{input} does not start with order_id,country,total"
        ));
    }
    let mut totals: std::collections::BTreeMap<String, (u64, u64)> =
        std::collections::BTreeMap::new();
    for (number, line) in lines
        .enumerate()
        .filter(|(_, line)| !line.trim().is_empty())
    {
        let fields: Vec<&str> = line.split(',').collect();
        let (Some(country), Some(total)) = (fields.get(1), fields.get(2)) else {
            return Err(format!("line {} has fewer than three fields", number + 2));
        };
        let total: u64 = total
            .trim()
            .parse()
            .map_err(|_| format!("line {} has a total that is not a whole number", number + 2))?;
        let entry = totals.entry(country.trim().to_string()).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += total;
    }
    let mut summary = String::from("country,orders,total\n");
    for (country, (orders, total)) in &totals {
        summary.push_str(&format!("{country},{orders},{total}\n"));
    }
    // Atomic: a reader never sees half a file.
    let temporary = format!("{output}.tmp");
    std::fs::write(&temporary, &summary)
        .and_then(|()| std::fs::rename(&temporary, output))
        .map_err(|error| format!("cannot write {output}: {error}"))?;
    let mut gzip = Command::new("/bin/gzip");
    gzip.args(["-n", "-c"]).input(summary.as_bytes());
    let compressed = gzip.output().map_err(|error| format!("gzip: {error}"))?;
    if compressed.status != ExitStatus::Exited(0) {
        return Err(format!("gzip ended with {:?}", compressed.status));
    }
    let gz = format!("{output}.gz");
    std::fs::write(&gz, &compressed.stdout)
        .map_err(|error| format!("cannot write {gz}: {error}"))?;
    let mut gunzip = Command::new("/bin/gzip");
    gunzip.args(["-d", "-c"]).input(compressed.stdout.clone());
    let restored = gunzip
        .output()
        .map_err(|error| format!("gzip -d: {error}"))?;
    if restored.stdout != summary.as_bytes() {
        return Err("the native round trip changed the summary".into());
    }
    let pid = oxidevm_bridge::process::info()
        .map(|info| info.pid)
        .map_err(|error| error.to_string())?;
    Ok(format!(
        "summary: {} countries, {} bytes; rust pid {pid}; gzip pid {} wrote {} bytes; gzip -d pid {} round trip ok",
        totals.len(),
        summary.len(),
        compressed.pid,
        compressed.stdout.len(),
        restored.pid
    ))
}

trait ReadWrite: io::Read + io::Write {}
impl<T: io::Read + io::Write> ReadWrite for T {}

/// Lets the exchange read and write a stream that its shutdown closure also borrows.
struct Shared<'a, T>(&'a std::cell::RefCell<T>);
impl<T: io::Read> io::Read for Shared<'_, T> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.0.borrow_mut().read(buffer)
    }
}
impl<T: io::Write> io::Write for Shared<'_, T> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.0.borrow_mut().write(buffer)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.borrow_mut().flush()
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("identity") => identity(args.get(2).is_some_and(|arg| arg == "--prompt")),
        Some("echo") => echo(),
        Some("run") => run(args.get(2..).unwrap_or_default()),
        Some("connect") => connect(args.get(2..).unwrap_or_default()),
        Some("summarize") => summarize(args.get(2..).unwrap_or_default()),
        _ => hello(&args),
    }
}
