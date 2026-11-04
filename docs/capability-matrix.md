# Rust standard library and bridge capability matrix

What a stock `wasm32-wasip1` Rust program can expect, by API. "Slice" names the step that makes it work (see the
README); nothing marked with a slice works yet. The import census (`pnpm run inspect:fixtures`) checks the fixtures in
`test/fixtures/rust` against `docs/wasi-preview1-imports.json`.

| Rust API | Preview1 imports it needs | First release | Slice | Notes |
| --- | --- | --- | --- | --- |
| `std::env::args`, `std::env::vars` | `args_*`, `environ_*` | yes | works | Strings are UTF-8: the SDK carries arguments and environment as strings, so non-UTF-8 `execve` bytes do not reach the program. |
| `println!`, `eprintln!`, `std::io::stdin/stdout/stderr` | `fd_read`, `fd_write`, `fd_fdstat_get` | yes | works | Binary-safe; partial writes keep order; EPIPE is a write error when SIGPIPE is ignored or blocked, otherwise the process dies of SIGPIPE. |
| `std::process::exit`, return from `main` | `proc_exit` | yes | works | 0..119 exact, larger values reported as 1 (`contract.md`). |
| `std::env::current_dir`, relative paths | `fd_prestat_*` | yes | SL-02, SL-04 | The caller's directory is a preopen only when it is granted; an ungranted directory fails before the program starts. |
| `std::fs::{read, write, File, OpenOptions, metadata, read_dir, create_dir_all, rename, remove_*, hard_link, read_link}` | `path_*`, `fd_*` | yes | SL-03, SL-04 | Live OxideVM files, the same inodes native programs see. Confinement beneath each preopen is done by the engine, not by path strings. |
| creating a symbolic link | `path_symlink` | bridge or unstable std | SL-04 | `std::os::wasi::fs::symlink_path` is unstable (`wasi_ext`) on Rust 1.99.1; stable code has no std call for it. |
| `File::set_len`, `sync_all`, `sync_data` | `fd_filestat_set_size`, `fd_sync`, `fd_datasync` | yes | SL-03, SL-04 | `sync_*` reports a storage failure as an error. |
| `File` positional IO (`std::os::wasi::fs::FileExt`) | `fd_pread`, `fd_pwrite` | yes | SL-03 | Does not move a shared description's offset. |
| `SystemTime::now`, `Instant::now`, `thread::sleep` | `clock_time_get`, `poll_oneoff` | yes | SL-05 | The VM's clock, not the browser's; sleeping blocks only this process. |
| `HashMap::new` (random keys), `getrandom` | `random_get` | yes | SL-05 | Until SL-05 a program that needs randomness aborts at start-up. |
| `std::process::Command` | none: compiled as unsupported | no | — | Use `oxidevm_bridge::process::Command` (SL-06). |
| `std::thread::spawn` | none: compiled as unsupported | no | — | Single-threaded guests only. |
| `std::net::{TcpStream, UdpSocket, TcpListener}` | none: compiled as unsupported | no | — | Use `oxidevm_bridge::net` client streams (SL-07). Listening is not part of command modules. |
| `oxidevm_bridge::process::{info, Command}` | `oxidevm_bridge_v1.*` | yes | SL-06 | Real child PIDs; binary stdio; exact child status; children end with the module. |
| `oxidevm_bridge::net::{TcpStream, UnixStream}` | `oxidevm_bridge_v1.*` | yes | SL-07 | VM sockets under the module's declared reach; TLS verified against the VM trust store. |
| Tokio, async runtimes, threads, `fork`, `dlopen`, GPU | — | no | — | Separate compatibility work (WASIX or a custom target), not part of the first release. |
