# oxidevm-rust

An OxideVM module for Rust programs compiled to WebAssembly (`wasm32-wasip1`): each run is a real Linux process of the
VM, with the caller's arguments, environment and standard streams, the VM's live files, and, through a small bridge
crate, native Linux programs and VM sockets.

**Status: under development, not released.** It needs an OxideVM SDK release with Userspace API 147, which is not
published yet. There is no release to install.

This module is a thin command layer. The WASI Preview1 implementation is the SDK's
[`host.kit.wasi`](https://oxidevm.dev/docs/reference/wasi-kit/), and the Rust crate programs link is
[`oxidevm-bridge`](https://oxidevm.dev/docs/reference/wasi-bridge/), which lives in the SDK repository
(`crates/oxidevm-bridge`) and goes to crates.io with the SDK release. Any module can run Rust programs the same way;
see the guide [Run Rust programs](https://oxidevm.dev/docs/guides/rust-programs/).

## Commands

- `rust-wasi [--dir <path>[:ro]]... <program.wasm> [--] [args...]` reads a `.wasm` file from the VM (at most 32 MiB),
  checks it before any of its code runs, and starts it as a Linux process with its own arguments. Without `--dir` the
  program may use the whole VM tree under the caller's permissions; `--dir` grants only the named directories, and
  `:ro` grants one read-only.
- `rust-bridge-demo` is a pinned example program (`examples/bridge-demo`) that exercises standard streams, files, native
  children and sockets; `rust-bridge-demo summarize <in.csv> <out.csv>` is the end-to-end example used by the
  `oxidevm-pyodide-test` sample.

Programs see standard streams, arguments, the environment, the VM's live files, its clocks and entropy through plain
Rust `std`. Native Linux programs, sockets, the process identity and the working directory come from `oxidevm-bridge`.
An exit status from 0 to 119 is reported exactly; a larger one is reported as 1 with a line naming the original.

## Network

The module declares `net.vm`: programs reach the VM's own TCP and Unix sockets through `oxidevm-bridge`, and nothing
outside the VM. The module itself makes no network requests.

## Develop

Until `oxidevm-bridge` is on crates.io, Cargo needs a checkout of it. `OXIDEVM_BRIDGE_PATH` names one, and
`scripts/cargo.ts` and `pnpm run build:rust` patch it in:

```sh
export OXIDEVM_BRIDGE_PATH=<oxidevm-sdk checkout>/crates/oxidevm-bridge
rustup target add wasm32-wasip1
pnpm install --frozen-lockfile
pnpm run build:rust
node scripts/cargo.ts clippy --workspace --all-targets --target wasm32-wasip1 -- -D warnings
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
