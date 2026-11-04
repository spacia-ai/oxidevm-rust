//! Exercises the standard-library calls the first release classifies (std capability matrix, SL-01). Each probe prints
//! one line, `<probe>: ok <detail>` or `<probe>: err <kind> <detail>`, so a run records what works on the adapter. A probe
//! named on the command line runs alone; with no names every probe runs, inside the directory given by $PROBE_DIR (or
//! the current directory).
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

type Probe = fn(&Path) -> std::io::Result<String>;

fn probes() -> Vec<(&'static str, Probe)> {
    vec![
        ("args", |_| {
            Ok(format!("{:?}", std::env::args().collect::<Vec<_>>()))
        }),
        ("env", |_| {
            Ok(format!("{} variables", std::env::vars_os().count()))
        }),
        ("current_dir", |_| {
            std::env::current_dir().map(|dir| dir.display().to_string())
        }),
        ("fs_write_read", |dir| {
            let path = dir.join("probe.txt");
            std::fs::write(&path, b"probe\0bytes")?;
            let bytes = std::fs::read(&path)?;
            Ok(format!("{} bytes", bytes.len()))
        }),
        ("fs_append_seek", |dir| {
            let path = dir.join("probe.txt");
            let mut file = std::fs::OpenOptions::new().append(true).open(&path)?;
            file.write_all(b"+")?;
            let mut text = Vec::new();
            std::fs::File::open(&path)?.read_to_end(&mut text)?;
            Ok(format!("{} bytes", text.len()))
        }),
        ("fs_metadata", |dir| {
            let meta = std::fs::metadata(dir.join("probe.txt"))?;
            Ok(format!(
                "len={} modified={:?}",
                meta.len(),
                meta.modified().is_ok()
            ))
        }),
        ("fs_create_dir_read_dir", |dir| {
            let sub = dir.join("probe.d");
            std::fs::create_dir_all(&sub)?;
            std::fs::write(sub.join("a"), b"a")?;
            let names: Vec<_> = std::fs::read_dir(&sub)?
                .filter_map(Result::ok)
                .map(|entry| entry.file_name())
                .collect();
            Ok(format!("{names:?}"))
        }),
        ("fs_rename", |dir| {
            std::fs::rename(dir.join("probe.d/a"), dir.join("probe.d/b"))?;
            Ok("renamed".into())
        }),
        ("fs_hard_link", |dir| {
            std::fs::hard_link(dir.join("probe.d/b"), dir.join("probe.d/c"))?;
            Ok("linked".into())
        }),
        // Creating a symbolic link has no stable std API on wasm32-wasip1 (std::os::wasi::fs is the unstable `wasi_ext`);
        // the harness creates `probe.link -> probe.txt` natively and this probe only reads it.
        ("fs_read_link", |dir| {
            let target = std::fs::read_link(dir.join("probe.link"))?;
            Ok(target.display().to_string())
        }),
        ("fs_set_len_sync", |dir| {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .open(dir.join("probe.txt"))?;
            file.set_len(3)?;
            file.sync_all()?;
            Ok("truncated and synced".into())
        }),
        ("fs_remove", |dir| {
            std::fs::remove_dir_all(dir.join("probe.d"))?;
            std::fs::remove_file(dir.join("probe.txt"))?;
            Ok("removed".into())
        }),
        ("time_system", |_| {
            let since = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_err(std::io::Error::other)?;
            Ok(format!("{}s", since.as_secs()))
        }),
        ("time_sleep", |_| {
            let start = Instant::now();
            std::thread::sleep(Duration::from_millis(50));
            Ok(format!("{}ms", start.elapsed().as_millis()))
        }),
        ("random_hashmap", |_| {
            let mut map = HashMap::new();
            map.insert(1, 2);
            Ok(format!("{} entries", map.len()))
        }),
        ("process_command", |_| {
            let status = std::process::Command::new("/bin/true").status()?;
            Ok(format!("{status}"))
        }),
        ("thread_spawn", |_| {
            let handle = std::thread::Builder::new().spawn(|| 1)?;
            handle
                .join()
                .map_err(|_| std::io::Error::other("panicked"))?;
            Ok("joined".into())
        }),
        ("net_tcp_connect", |_| {
            std::net::TcpStream::connect("127.0.0.1:9")?;
            Ok("connected".into())
        }),
    ]
}

fn main() {
    let selected: Vec<String> = std::env::args().skip(1).collect();
    let dir = std::env::var_os("PROBE_DIR").map_or_else(|| PathBuf::from("."), PathBuf::from);
    for (name, probe) in probes() {
        if !selected.is_empty() && !selected.iter().any(|wanted| wanted == name) {
            continue;
        }
        match probe(&dir) {
            Ok(detail) => println!("{name}: ok {detail}"),
            Err(error) => println!("{name}: err {:?} {error}", error.kind()),
        }
    }
}
