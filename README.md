# oxidevm-rust

An OxideVM module for Rust programs compiled to WebAssembly (`wasm32-wasip1`): each run is a real Linux process of the
VM, with the caller's arguments, environment and standard streams, the VM's live files, and, through a small bridge
crate, native Linux programs and VM sockets.

**Status: under development, not released.** The module runs a pinned Rust program with its arguments, standard streams,
exit status, real process identity and working directory. Files, clocks, native child processes, sockets and running
your own `.wasm` files are not implemented yet. There is no release to install.

## What works today

- `rust-bridge-demo`, a pinned Rust program, runs as a module command with argv, environment, binary-safe standard
  streams and its exit status (0-119 exactly; a larger code is reported as 1 with a line naming the original).
- Programs are checked before they run: only WASI Preview1 and `oxidevm_bridge_v1` function imports are admitted.
- `oxidevm-bridge` (crates/oxidevm-bridge) reports the VM's pid, parent, uid, gid and the caller's directory, and moves
  wasi-libc to that directory before `main`. `IsTerminal` agrees with Linux `isatty`.

## Roadmap

The docs and code name these steps:

| Step | Outcome |
| --- | --- |
| SL-01 | First-release contract, fixtures and the synchronous host seam (done) |
| SL-02 | Process identity, launch context and standard streams (done) |
| SL-03 | Descriptor-relative, positional and readiness operations in the OxideVM SDK and engine |
| SL-04 | WASI files on the VM's live filesystem, confined to granted directories by the engine |
| SL-05 | Clocks, sleeping, polling and randomness without busy waiting |
| SL-06 | `oxidevm_bridge::process` for native Linux programs, owned by the module |
| SL-07 | `oxidevm_bridge::net` client streams under the module's declared reach |
| SL-08 | `rust-wasi <program.wasm>` for `.wasm` files from the VM's filesystem |
| SL-09 – SL-11 | An end-to-end example, browser qualification, and the first release |

Plain Rust `std` covers standard streams, arguments, environment and, as the roadmap lands, files and clocks.
`std::process`, `std::thread` and `std::net` are compiled as unsupported for `wasm32-wasip1`; the `oxidevm-bridge` crate
provides native processes and sockets instead.

## Network

The module declares no network reach and makes no network requests.

## Develop

```sh
rustup target add wasm32-wasip1
pnpm install --frozen-lockfile
pnpm run build:rust
pnpm run inspect:fixtures
pnpm run check
pnpm test
pnpm run test:conformance
```

Real-engine browser suites (`test/browser/suites`) need a signed Userspace image with a POSIX shell and coreutils-style
tools:

```sh
OXIDEVM_TEST_USERSPACE_IMAGE=<image reference JSON> OXIDEVM_TEST_USERSPACE_IMAGE_DIR=<bundle directory> \
  pnpm run test:browser stdio --browser chromium
```

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
