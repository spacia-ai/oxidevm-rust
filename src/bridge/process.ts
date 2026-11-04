import { WASI, type WasiErrno } from "../errno.ts";
import { GuestFault, type GuestMemory } from "../memory.ts";

/** What the program's process is, read once from the VM before the program starts (`process.info`). */
export interface Identity {
  readonly pid: number;
  /** The parent when the process started; 0 when it has none. */
  readonly parent: number;
  readonly uid: number;
  readonly gid: number;
  /** The caller's working directory, absolute. */
  readonly cwd: string;
}

type ImportFunction = (...args: never[]) => number;
export const PROCESS_FUNCTIONS = ["process_info", "process_cwd"] as const;

/** The process part of `oxidevm_bridge_v1`. Every out-pointer is checked before anything is written. */
export function bridgeProcess(memory: () => GuestMemory, identity: Identity): Readonly<Record<(typeof PROCESS_FUNCTIONS)[number], ImportFunction>> {
  const cwd = new TextEncoder().encode(identity.cwd);
  const guarded = (body: () => void): WasiErrno => {
    try { body(); return WASI.success; } catch (error) { if (error instanceof GuestFault) return WASI.fault; throw error; }
  };
  return {
    process_info: (out: number) => guarded(() => {
      const guest = memory();
      guest.check(out, 16);
      [identity.pid, identity.parent, identity.uid, identity.gid].forEach((value, index) => { guest.setU32(out + index * 4, value); });
    }),
    process_cwd: (buffer: number, length: number, outLength: number) => guarded(() => {
      const guest = memory();
      guest.check(buffer, length); guest.check(outLength, 4);
      guest.write(buffer, cwd.subarray(0, length));
      guest.setU32(outLength, cwd.byteLength);
    }),
  };
}
