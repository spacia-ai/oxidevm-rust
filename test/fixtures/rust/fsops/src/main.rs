//! File operations for the real-engine suites: each operation prints `<op>: ok <detail>` or `<op>: err <ErrorKind>`,
//! so a shell script can compare the outcome with what native tools see. It links oxidevm-bridge, which moves wasi-libc
//! to the caller's directory before `main`, so relative paths resolve as they would natively.
//!
//!   fsops cat <path> | write <path> <text> | append <path> <text> | ls <dir> | mkdir <dir> | rm <path> | rmdir <dir>
//!   fsops mv <from> <to> | stat <path> | sleep <ms> | cwd
use std::io::{Read, Write};
use std::process::ExitCode;
use std::time::{Duration, Instant};

fn run(args: &[String]) -> std::io::Result<String> {
    let arg = |index: usize| {
        args.get(index).map(String::as_str).ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "missing argument")
        })
    };
    match arg(0)? {
        "cat" => {
            let mut text = String::new();
            std::fs::File::open(arg(1)?)?.read_to_string(&mut text)?;
            Ok(text)
        }
        "write" => std::fs::write(arg(1)?, arg(2)?).map(|()| "written".into()),
        "append" => {
            let mut file = std::fs::OpenOptions::new()
                .append(true)
                .create(true)
                .open(arg(1)?)?;
            file.write_all(arg(2)?.as_bytes())?;
            Ok("appended".into())
        }
        "ls" => {
            let mut names: Vec<String> = std::fs::read_dir(arg(1)?)?
                .filter_map(Result::ok)
                .map(|entry| entry.file_name().to_string_lossy().into_owned())
                .collect();
            names.sort();
            Ok(names.join(","))
        }
        "mkdir" => std::fs::create_dir(arg(1)?).map(|()| "created".into()),
        "rm" => std::fs::remove_file(arg(1)?).map(|()| "removed".into()),
        "rmdir" => std::fs::remove_dir(arg(1)?).map(|()| "removed".into()),
        "mv" => std::fs::rename(arg(1)?, arg(2)?).map(|()| "moved".into()),
        "stat" => {
            let meta = std::fs::symlink_metadata(arg(1)?)?;
            Ok(format!(
                "len={} dir={} link={}",
                meta.len(),
                meta.is_dir(),
                meta.file_type().is_symlink()
            ))
        }
        "sleep" => {
            let millis: u64 = arg(1)?
                .parse()
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad ms"))?;
            let start = Instant::now();
            std::thread::sleep(Duration::from_millis(millis));
            Ok(format!(
                "slept {}ms",
                start.elapsed().as_millis() / 100 * 100
            ))
        }
        "cwd" => std::env::current_dir().map(|dir| dir.display().to_string()),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "unknown operation",
        )),
    }
}

fn main() -> ExitCode {
    // Linking the bridge restores the caller's directory; referencing it keeps the crate in the link.
    let _ = oxidevm_bridge::process::cwd;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let op = args.first().cloned().unwrap_or_default();
    match run(&args) {
        Ok(detail) => {
            println!("{op}: ok {detail}");
            ExitCode::SUCCESS
        }
        Err(error) => {
            println!("{op}: err {:?}", error.kind());
            ExitCode::from(1)
        }
    }
}
