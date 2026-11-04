import type { BaseHost, CommandHooks, Host, Stdio } from "@oxidevm/sdk/wasm";
import { bridgeProcess, PROCESS_FUNCTIONS, type Identity } from "./bridge/process.ts";
import { mapGuestExit } from "./exit.ts";
import { GuestMemory } from "./memory.ts";
import { admitProgram, AdmissionError } from "./wasi/admission.ts";
import { BRIDGE_NAMESPACE, PREVIEW1_NAMESPACE } from "./wasi/imports.ts";
import { encodeLaunch, LaunchError, preview1, ProcExit, type Preview1Host } from "./wasi/preview1.ts";

/** The host members a Rust command uses: its standard streams, the kit, failure reporting and Linux files. */
export type RustCommandHost = Pick<BaseHost, "fail"> & Preview1Host & { readonly process: Pick<Host<"process.info">["process"], "info"> };

/** The commands this module declares (module.ts `commands`). */
export type RustCommandName = "rust-bridge-demo";

/** The bridge functions this release serves (oxidevm_bridge_v1); native processes and sockets follow. */
const BRIDGE_FUNCTIONS: ReadonlySet<string> = new Set(PROCESS_FUNCTIONS);

/**
 * Runs one compiled wasm32-wasip1 Rust command per invocation: the program is admitted once, and every run gets a fresh
 * instance (memory, globals and table), so nothing a run leaves behind reaches the next.
 */
export function rustCommand(host: RustCommandHost, program: WebAssembly.Module, defaultName: RustCommandName): CommandHooks<RustCommandName> {
  admitProgram(program, BRIDGE_FUNCTIONS);
  return {
    async main(io) {
      const argv0 = io.invocation.kind === "command" ? io.invocation.argv0 : defaultName;
      let launch;
      try { launch = encodeLaunch([argv0, ...io.args], io.env); }
      catch (error) { if (error instanceof LaunchError) return host.fail(2, `${argv0}: ${error.message}`); throw error; }
      const stdio: Stdio = { stdin: io.stdin, stdout: io.stdout, stderr: io.stderr };
      // The process's identity does not change while it runs, except its parent on reparenting: read it once, before
      // the program starts (the program cannot await later). The directory is the caller's, as the runner reports it.
      const info = await host.process.info();
      const identity: Identity = { pid: info.pid, parent: info.parentPid ?? 0, uid: info.uid, gid: info.gid, cwd: io.cwd };
      // Bound once the instance exists; an import called before that (a start function) finds no memory and fails.
      const bound: { memory?: GuestMemory } = {};
      const memory = (): GuestMemory => { if (bound.memory === undefined) throw new AdmissionError("memory is not bound yet"); return bound.memory; };
      const instance = new WebAssembly.Instance(program, {
        [PREVIEW1_NAMESPACE]: preview1(host, memory, stdio, launch, io.terminals),
        [BRIDGE_NAMESPACE]: bridgeProcess(memory, identity),
      });
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
