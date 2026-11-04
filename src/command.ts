import type { LinuxSyncFiles } from "@oxidevm/sdk/js-process";
import type { CommandHooks, Kit, WasiRunHost } from "@oxidevm/sdk/wasm";
import { runner } from "./runner.ts";

/**
 * What the module's commands use: the SDK's WASI runner (`host.kit.wasi`) and the host members it serves programs
 * from, plus `fs.open` for the program files `rust-wasi` reads.
 */
export type RustHost = WasiRunHost & {
  readonly kit: Pick<Kit, "wasi">;
  readonly fs: Pick<LinuxSyncFiles, "open">;
};

/** The commands this module declares (module.ts `commands`). */
export type RustCommandName = "rust-bridge-demo" | "rust-wasi";

/**
 * `rust-bridge-demo` runs the pinned demonstration program, `rust-wasi` a program file from the VM's filesystem. An
 * application start (`spawnModule`) runs the demonstration program. Each run gets fresh state; only compiled programs
 * are shared.
 */
export function rustCommand(host: RustHost, demo: WebAssembly.Module): CommandHooks<RustCommandName> {
  host.kit.wasi.admit(demo);
  const runWasi = runner(host);
  return {
    main(io) {
      if (io.invocation.kind === "command" && io.invocation.name === "rust-wasi") return runWasi(io);
      const argv0 = io.invocation.kind === "command" ? io.invocation.argv0 : "rust-bridge-demo";
      return host.kit.wasi.run(host, demo, io, { argv: [argv0, ...io.args] });
    },
  };
}
