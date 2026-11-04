import { defineModule } from "@oxidevm/sdk/wasm";
import { rustCommand } from "./src/command.ts";

export default defineModule({
  manifest: {
    id: "oxidevm-rust",
    version: "0.0.0",
    abi: "wasi",
    // SL-01: the pinned demonstration program is the `hello` fixture (test/fixtures/rust/hello), built with the pinned
    // toolchain for wasm32-wasip1. SL-02 onward replaces it with examples/bridge-demo.
    artifacts: [{ name: "bridge-demo.wasm", from: "upstream/bridge-demo.wasm" }],
    process: { kind: "command" },
    commands: ["rust-bridge-demo"],
    requires: { host: ["files.sync"] },
    license: { spdx: "Apache-2.0" },
  },
  adapter: async host => rustCommand(host, await host.artifacts.compile("bridge-demo.wasm"), "rust-bridge-demo"),
});
