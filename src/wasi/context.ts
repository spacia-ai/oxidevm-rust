import { WASI, wasiErrno, type WasiErrno } from "../errno.ts";
import type { AtFiles, WasiHost } from "../host.ts";
import { GuestFault, type GuestMemory } from "../memory.ts";
import { WasiError } from "./context-error.ts";
import type { DescriptorTable } from "./descriptors.ts";

export { WasiError } from "./context-error.ts";

/** What every Preview1 function shares in one run: the host ports, the guest's memory and the descriptor table. */
export class WasiContext {
  constructor(readonly host: WasiHost, readonly memory: () => GuestMemory, readonly table: DescriptorTable) {}

  /** The `files.at` port, or NOSYS when this SDK does not provide it. */
  get at(): AtFiles {
    const at = this.host.at;
    if (at === undefined) throw new WasiError(WASI.nosys);
    return at;
  }

  /**
   * Runs one import body and turns its outcome into a WASI errno: a decided refusal keeps its errno, a guest range
   * outside memory is FAULT, a Linux failure maps through the errno table. Anything else is an adapter bug and
   * propagates (the run fails loudly instead of returning a wrong errno).
   */
  /** Throws NOSYS unless the files.at port exists (checked before reading guest buffers). */
  requireAt(): void { void this.at; }

  guarded(body: () => void): WasiErrno {
    try { body(); return WASI.success; } catch (error) { return this.errnoOf(error); }
  }

  errnoOf(error: unknown): WasiErrno {
    if (error instanceof WasiError) return error.errno;
    if (error instanceof GuestFault) return WASI.fault;
    const linux = this.host.kit.errno.of(error);
    if (linux === undefined) throw error;
    return wasiErrno(linux);
  }
}
