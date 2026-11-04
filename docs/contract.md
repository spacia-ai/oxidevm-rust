# First-release contract

Status: frozen for the first release on 2026-11-04. Nothing here is implemented beyond what the "Today" column says. A
change to a value in this file is a contract change: update the boundary tests with it.

## Execution model

- A program is a stock Rust `wasm32-wasip1` command (`_start`, one exported memory), compiled before it reaches the VM.
  The module has no compiler: it is not `rustc` or `cargo`.
- Each run is a real Linux process of the VM, started by a shell, another program or the application. It runs in the
  module's isolated worker with a fresh WebAssembly instance (memory, globals, table, descriptor and handle tables). Only
  the compiled module is shared between runs.
- Every host call is synchronous: the worker blocks on its Linux mailbox while Rust owns scheduling, readiness and
  reaping. Neither WebAssembly JSPI nor Asyncify is used. A kill of the process ends the worker, whatever it was doing.
- Direct WebAssembly computation is not x86 code. It is not counted in the VM's instruction budgets, and a live program
  is not part of a restore point. Only files it committed survive.

## Profile limits

| Boundary | Limit | Enforced by | Today |
| --- | --- | --- | --- |
| argv / environment | 64 KiB each, NUL terminators included; no NUL inside a string | `encodeLaunch` before guest entry | tested |
| iovec list | ≤128 entries, ≤1 MiB in total, every buffer inside memory | `GuestMemory.ioVectors` before any IO | tested |
| host transfer | 64 KiB per host read or write; partial counts returned as WASI requires | Preview1 `fd_read`/`fd_write` | tested |
| linear memory | one defined, unshared, 32-bit memory with a declared maximum ≤4096 pages (256 MiB) | admission (SL-08 for local programs) | census |
| table | at most one funcref table with a declared maximum ≤65536 | admission (SL-08) | census |
| start section | refused | admission (SL-08) | census |
| imports | functions only, from `wasi_snapshot_preview1` (by name) or `oxidevm_bridge_v1` (by name) | `admitProgram` | tested |
| path | 4095 bytes, NUL refused | SL-03/SL-04 | — |
| guest handles | 256 per run, inherited and preopened descriptors included | SL-04/SL-06 | — |
| retained native results | 8 MiB per run | SL-06 | — |
| poll subscriptions | 1..16 | SL-05 | — |
| native argv | 1..64 strings, absolute executable, no NUL | SL-06 | — |
| captured native IO | ≤5 MiB input, ≤1 MiB per output stream | SL-06 | — |
| native deadline | 1..180000 ms | SL-06 | — |
| local program file | 32 MiB | SL-08 | — |
| program run | 180 s by default, enforced outside the worker | SL-08 | — |

The stock toolchain, with `.cargo/config.toml` (`--max-memory=268435456`, 1 MiB stack), produces an admitted shape: one
memory with a maximum of 4096 pages, one fixed-size funcref table and no start section (`pnpm run inspect:fixtures`).

## Exit status

| The program | The module reports |
| --- | --- |
| returns from `main`, or `proc_exit(0..119)` | that status exactly |
| `proc_exit(120..2^32-1)` | status 1 and the line `<argv0>: the program exited with status N, which a module command cannot report exactly (0-119); reporting 1` |
| is killed by a signal | the shell sees the signal (for example 137 for SIGKILL); there is no unwinding |
| traps (a Rust panic with `panic = "abort"`, an out-of-bounds access) | the runner's adapter failure status |

A native child's own result is never squeezed into this range: the bridge reports it as `Exited(code)` or
`Signaled(signal)` (see `abi-v1.md`).

## Errors

Linux errors become WASI Preview1 errno values (`src/errno.ts`), never raw Linux numbers. A Linux error with no WASI
name becomes `io`. A function a later slice implements returns its disposition's error (`docs/wasi-preview1-imports.json`),
never false success.
