# oxidevm-rust

An OxideVM module for Rust programs compiled to WebAssembly (`wasm32-wasip1`): each run is a real Linux process of the
VM, with the caller's arguments, environment and standard streams, the VM's live files, and, through a small bridge
crate, native Linux programs and VM sockets.

**Status: under development, not released.** The module runs a pinned Rust program with its arguments, standard streams
and exit status. Files, clocks, native child processes, sockets and running your own `.wasm` files are not implemented
yet. There is no release to install.

## What works today

- `rust-bridge-demo`, a pinned Rust program, runs as a module command with argv, environment, binary-safe standard
  streams and its exit status (0-119 exactly; see [docs/contract.md](docs/contract.md)).
- Programs are checked before they run: only WASI Preview1 and `oxidevm_bridge_v1` function imports are admitted.

## Roadmap

The docs and code name these steps:

| Step | Outcome |
| --- | --- |
| SL-01 | First-release contract, fixtures and the synchronous host seam (this branch) |
| SL-02 | Process identity, launch context and standard streams |
| SL-03 | Descriptor-relative, positional and readiness operations in the OxideVM SDK and engine |
| SL-04 | WASI files on the VM's live filesystem, confined to granted directories by the engine |
| SL-05 | Clocks, sleeping, polling and randomness without busy waiting |
| SL-06 | `oxidevm_bridge::process` for native Linux programs, owned by the module |
| SL-07 | `oxidevm_bridge::net` client streams under the module's declared reach |
| SL-08 | `rust-wasi <program.wasm>` for `.wasm` files from the VM's filesystem |
| SL-09 – SL-11 | An end-to-end example, browser qualification, and the first release |

[docs/capability-matrix.md](docs/capability-matrix.md) lists which Rust standard-library APIs the first release supports
and which need the bridge; [docs/abi-v1.md](docs/abi-v1.md) is the bridge's import ABI.

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

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
