import type { BaseHost, CommandHooks, Stdio } from "@oxidevm/sdk/wasm";
import { mapGuestExit } from "./exit.ts";
import { GuestMemory } from "./memory.ts";
import { admitProgram, AdmissionError } from "./wasi/admission.ts";
import { PREVIEW1_NAMESPACE } from "./wasi/imports.ts";
import { encodeLaunch, LaunchError, preview1, ProcExit, type Preview1Host } from "./wasi/preview1.ts";

/** The host members a Rust command uses: its standard streams, the kit, failure reporting and Linux files. */
export type RustCommandHost = Pick<BaseHost, "fail"> & Preview1Host;

/** The commands this module declares (module.ts `commands`). */
export type RustCommandName = "rust-bridge-demo";

/** The bridge functions this release serves (oxidevm_bridge_v1); empty until SL-06. */
const BRIDGE_FUNCTIONS: ReadonlySet<string> = new Set();

/**
 * Runs one compiled wasm32-wasip1 Rust command per invocation: the program is admitted once, and every run gets a fresh
 * instance (memory, globals and table), so nothing a run leaves behind reaches the next.
 */
export function rustCommand(host: RustCommandHost, program: WebAssembly.Module, defaultName: RustCommandName): CommandHooks<RustCommandName> {
  admitProgram(program, BRIDGE_FUNCTIONS);
  return {
    main(io) {
      const argv0 = io.invocation.kind === "command" ? io.invocation.argv0 : defaultName;
      let launch;
      try { launch = encodeLaunch([argv0, ...io.args], io.env); }
      catch (error) { if (error instanceof LaunchError) return host.fail(2, `${argv0}: ${error.message}`); throw error; }
      const stdio: Stdio = { stdin: io.stdin, stdout: io.stdout, stderr: io.stderr };
      // Bound once the instance exists; an import called before that (a start function) finds no memory and fails.
      const bound: { memory?: GuestMemory } = {};
      const memory = (): GuestMemory => { if (bound.memory === undefined) throw new AdmissionError("memory is not bound yet"); return bound.memory; };
      const instance = new WebAssembly.Instance(program, { [PREVIEW1_NAMESPACE]: preview1(host, memory, stdio, launch) });
      const exported = instance.exports["memory"], start = instance.exports["_start"];
      if (!(exported instanceof WebAssembly.Memory) || typeof start !== "function") throw new AdmissionError("the program lost its memory or _start export");
      bound.memory = new GuestMemory(exported);
      try {
        Reflect.apply(start, undefined, []);
        return 0;
      } catch (error) {
        if (!(error instanceof ProcExit)) throw error;
        const mapped = mapGuestExit(error.code, argv0);
        return mapped.diagnostic === undefined ? mapped.status : host.fail(mapped.status, mapped.diagnostic);
      }
    },
  };
}
