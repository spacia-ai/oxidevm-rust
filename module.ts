import { defineModule } from "@oxidevm/sdk/wasm";
import { rustCommand } from "./src/command.ts";

export default defineModule({
  manifest: {
    id: "oxidevm-rust",
    version: "0.0.0",
    abi: "wasi",
    // The pinned demonstration program, built from examples/bridge-demo with the pinned toolchain (scripts/build-wasm.ts).
    artifacts: [{ name: "bridge-demo.wasm", from: "upstream/bridge-demo.wasm" }],
    process: { kind: "command" },
    commands: ["rust-bridge-demo"],
    requires: { host: ["files.sync", "process.info"] },
    license: { spdx: "Apache-2.0" },
  },
  // `files.at`, `clock`, `random` and `process.sync` arrive with the next SDK release; until then those operations
  // answer NOSYS.
  adapter: async host => rustCommand({ ...host, at: undefined, clock: undefined, random: undefined, processSync: undefined, netSync: undefined }, await host.artifacts.compile("bridge-demo.wasm"), "rust-bridge-demo"),
});
