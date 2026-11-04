import type { CommandHooks, CommandIO } from "@oxidevm/sdk/wasm";
import { admit, runProgram, type RustCommandHost } from "./run.ts";
import { runner } from "./runner.ts";
import type { Preopen } from "./wasi/preview1.ts";

export type { RustCommandHost } from "./run.ts";

/** The commands this module declares (module.ts `commands`). */
export type RustCommandName = "rust-bridge-demo" | "rust-wasi";

/**
 * The module's commands: `rust-bridge-demo` runs the pinned demonstration program, `rust-wasi` a program file from the
 * VM's filesystem. An application start (`spawnModule`) runs the demonstration program.
 */
export function rustCommand(host: RustCommandHost, demo: WebAssembly.Module, defaultName: "rust-bridge-demo", preopens?: readonly Preopen[]): CommandHooks<RustCommandName> {
  admit(demo);
  const runWasi = runner(host);
  return {
    main(io: CommandIO<RustCommandName>) {
      if (io.invocation.kind === "command" && io.invocation.name === "rust-wasi") return runWasi(io);
      const argv0 = io.invocation.kind === "command" ? io.invocation.argv0 : defaultName;
      return runProgram(host, demo, { argv: [argv0, ...io.args], env: io.env, cwd: io.cwd, stdio: io, terminals: io.terminals, ...(preopens === undefined ? {} : { preopens }) });
    },
  };
}
