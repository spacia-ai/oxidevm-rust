# `oxidevm_bridge_v1` import ABI

Status: frozen for the first release on 2026-11-04, not yet implemented (process functions in SL-06, sockets in SL-07).
The `oxidevm-bridge` crate wraps these imports in a safe API; programs should not call them directly.

## Conventions

- Namespace `oxidevm_bridge_v1`. A program that imports another major (`oxidevm_bridge_v2`) or an unknown name is
  refused before it starts.
- Every function takes and returns WebAssembly `i32` (`u32` in Rust) except where noted, and returns a WASI Preview1
  errno: 0 for success. Results go to caller-provided out-pointers.
- Pointers and lengths are guest `u32`; integers in records are little-endian. The host checks every range (and every
  out-pointer) against linear memory before any side effect. Nothing is written on failure.
- Strings are UTF-8 without NUL; byte buffers are raw. Argument lists are encoded as `count: u32` followed by `count`
  entries of `len: u32, bytes`.
- Handles are per-run, never reused while open, and counted against the run's 256-entry table together with WASI
  descriptors. A stale or forged handle returns `badf`.
- The host never repeats a side effect to discover a size: a command runs once, and its output is retained (within the
  8 MiB per-run budget) behind a handle the program reads and closes.

## Process

| Function | Signature | Meaning |
| --- | --- | --- |
| `process_info` | `(out: *mut ProcessInfo) -> errno` | `ProcessInfo { pid: u32, parent: u32 /* 0 = none */, uid: u32, gid: u32 }` |
| `command_run` | `(request: *const u8, request_len: u32, out_handle: *mut u32, out_sizes: *mut [u32; 2]) -> errno` | Runs a native program to completion with piped stdio and returns a result handle plus the stdout/stderr sizes. |
| `result_status` | `(handle: u32, out: *mut Outcome) -> errno` | `Outcome { pid: u32, kind: u32 /* 0 exited, 1 signaled */, value: u32 }`; the child's full status, never truncated to the module's 0..119. |
| `result_read` | `(handle: u32, stream: u32 /* 1 stdout, 2 stderr */, offset: u32, buffer: *mut u8, len: u32, out_read: *mut u32) -> errno` | Copies retained output. |
| `result_close` | `(handle: u32) -> errno` | Releases the handle and its retained bytes. |

`command_run` request record, in order: `executable` (string, absolute path), `args` (list, 0..63 entries, so argv is
1..64 with the executable), `cwd` (u8 present flag, then string), `env` (u8 present flag, then list of `KEY=VALUE`),
`stdin` (bytes, ≤5 MiB), `timeout_ms` (u32, 1..180000), `stdout_limit` and `stderr_limit` (u32, ≤1 MiB each). There is
no shell interpolation and no PATH lookup.

Lifetime: a child started by `command_run` belongs to the module process. It is killed and reaped when its deadline
passes, when the request is cancelled, and when the module process ends for any reason, SIGKILL included. Only the
direct child is owned: descendants it forks follow ordinary Linux rules, and capture still ends within its deadline when
one of them holds a pipe open.

Errors (WASI numbering): `inval` (a malformed request or a value outside its bound; nothing was started), `noent`,
`acces` or `noexec` (the executable is missing, not permitted or not executable; nothing was started), `toobig` (an
output limit was exceeded; the child was ended and reaped), `timedout` (the deadline passed; the child was ended and
reaped), `intr` (a signal for the module interrupted the wait; the child was ended and reaped), `nosys` (the module
does not declare native-process authority).

## Sockets

| Function | Signature | Meaning |
| --- | --- | --- |
| `net_connect` | `(request: *const u8, request_len: u32, out_handle: *mut u32) -> errno` | `kind: u8` (0 TCP, 1 TCP+TLS, 2 Unix), then host and port, or a Unix path; ALPN list for TLS. |
| `net_read` | `(handle: u32, buffer: *mut u8, len: u32, timeout_ms: u32 /* 0xffffffff = none */, out_read: *mut u32) -> errno` | 0 bytes read is the peer's end of stream. |
| `net_write` | `(handle: u32, buffer: *const u8, len: u32, out_written: *mut u32) -> errno` | Never raises SIGPIPE: a closed peer is `pipe`. |
| `net_shutdown` | `(handle: u32, how: u32 /* 1 read, 2 write, 3 both */) -> errno` | |
| `net_close` | `(handle: u32) -> errno` | |

Connections use the module process's own VM sockets and its declared reach (none, VM, or internet). A module without a
reach gets `acces` before any traffic. TLS always verifies against the VM's `/etc/ssl/cert.pem`.
