import { defineModule } from "@oxidevm/sdk/wasm";
import { rustCommand } from "./src/command.ts";

export default defineModule({
  manifest: {
    id: "oxidevm-rust",
    version: "0.1.0",
    abi: "wasi",
    // The pinned demonstration program, built from examples/bridge-demo with the pinned toolchain (scripts/build-wasm.ts).
    artifacts: [{ name: "bridge-demo.wasm", from: "upstream/bridge-demo.wasm" }],
    process: { kind: "command" },
    commands: ["rust-bridge-demo", "rust-wasi"],
    requires: { host: ["files.sync", "files.at", "clock", "random", "process.info", "process.sync", "net.vm"] },
    license: { spdx: "Apache-2.0" },
  },
  adapter: async host => rustCommand(host, await host.kit.wasi.compile(await host.artifacts.bytes("bridge-demo.wasm"))),
});
