# oxidevm-rust: instructions for coding agents

This repository is an OxideVM WebAssembly module that runs Rust programs compiled for `wasm32-wasip1` as real Linux
processes of a VM. `module.ts` holds the whole definition: a literal `manifest` and the `adapter`.

- Edit `module.ts`, `src/`, `test/`, `docs/`, `scripts/` and `test/fixtures/rust/`. Never edit `dist/` or `target/`.
- Keep the manifest a literal, and declare in `requires.host` only what the adapter uses.
- Import types from `@oxidevm/sdk/wasm` with `import type`; the only value import is `defineModule`. Never import the
  SDK's private `runtime/` paths.
- No `any`, no `@ts-ignore`, no non-null assertions, no unchecked casts. Treat guest memory, WebAssembly exports and
  everything else from outside as untrusted and check it before any host side effect.
- Linux semantics belong to the engine: the adapter never resolves, checks or rewrites paths itself, never keeps a copy
  of files, and never imitates a process or socket.
- The limits in `docs/contract.md`, the ABI in `docs/abi-v1.md` and the dispositions in `docs/wasi-preview1-imports.json`
  are contracts: change them only together with their boundary tests.
- Rust: edition 2024, Rust 1.99.1 (`rust-toolchain.toml`), `unsafe_code = "deny"` except at the one import boundary of
  the bridge crate, no `unwrap`/`expect` in library code.
- Write the failing test first. Verify with `pnpm run build:rust`, `pnpm run inspect:fixtures`, `pnpm run check`,
  `pnpm test`, `cargo fmt --all -- --check`, `cargo clippy --locked --workspace --all-targets --target wasm32-wasip1 -- -D warnings`,
  then `pnpm run test:conformance` (a real browser).
- Commits, tags, pull requests and release notes in this repository are the maintainer's: authored as
  `Łukasz Potępa <lukasz@spacia.ai>`, with no AI attribution (no `Co-Authored-By` trailer, no "Generated with" line).
  Before pushing, `git log origin/main..HEAD --format='%an <%ae> | %cn <%ce> | %B' | grep -iE '^co-authored-by:|generated with'`
  must print nothing.
