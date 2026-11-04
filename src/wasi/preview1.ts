import type { BaseHost, Host, Stdio } from "@oxidevm/sdk/wasm";
import { WASI, wasiErrno, type WasiErrno } from "../errno.ts";
import { LIMITS } from "../limits.ts";
import { GuestFault, type GuestMemory, type IoVector } from "../memory.ts";
import { PREVIEW1_IMPORTS, type Preview1Name } from "./imports.ts";

/** What the Preview1 imports use: the process's own Linux streams and the kit's errno reader, nothing more. */
export interface Preview1Host {
  readonly kit: { readonly errno: Pick<BaseHost["kit"]["errno"], "of"> };
  readonly fs: Pick<Host<"files.sync">["fs"], "read" | "write" | "fstat">;
}

/** Thrown by proc_exit to unwind the guest; the command maps `code` to its status. */
export class ProcExit extends Error {
  override readonly name = "ProcExit";
  constructor(readonly code: number) { super(`proc_exit(${String(code)})`); }
}

/** The launch values a program receives: each string already NUL-terminated UTF-8, within LIMITS.launchBytes. */
export interface Launch { readonly argv: readonly Uint8Array[]; readonly environ: readonly Uint8Array[] }

/** A launch the profile refuses before guest entry (too large, or a string with NUL). */
export class LaunchError extends Error {
  override readonly name = "LaunchError";
}

export function encodeLaunch(argv: readonly string[], env: Readonly<Record<string, string>>): Launch {
  const encoder = new TextEncoder();
  const encode = (label: string, values: readonly string[]): readonly Uint8Array[] => {
    let total = 0;
    return values.map(value => {
      if (value.includes("\0")) throw new LaunchError(`${label} contains a NUL character`);
      const bytes = encoder.encode(`${value}\0`);
      total += bytes.byteLength;
      if (total > LIMITS.launchBytes) throw new LaunchError(`${label} exceeds ${String(LIMITS.launchBytes)} bytes`);
      return bytes;
    });
  };
  return { argv: encode("argv", argv), environ: encode("the environment", Object.entries(env).map(([key, value]) => `${key}=${value}`)) };
}

type ImportFunction = (...args: never[]) => number;

/** What each Preview1 function does before its slice implements it: the disposition table's explicit error. */
const PENDING: Readonly<Partial<Record<Preview1Name, WasiErrno>>> = {
  fd_advise: WASI.notsup, fd_allocate: WASI.notsup,
  // No preopened directories until SL-04: libc then reports paths as not capable instead of guessing a root.
  fd_prestat_get: WASI.badf, fd_prestat_dir_name: WASI.badf,
  sock_accept: WASI.badf, sock_recv: WASI.badf, sock_send: WASI.badf, sock_shutdown: WASI.badf,
};

const FILETYPE_UNKNOWN = 0, FILETYPE_CHARACTER_DEVICE = 2, FILETYPE_DIRECTORY = 3, FILETYPE_REGULAR = 4, FILETYPE_SOCKET_STREAM = 6;
function filetype(mode: number): number {
  switch (mode & 0o170000) {
    case 0o020000: return FILETYPE_CHARACTER_DEVICE;
    case 0o100000: return FILETYPE_REGULAR;
    case 0o040000: return FILETYPE_DIRECTORY;
    case 0o140000: return FILETYPE_SOCKET_STREAM;
    default: return FILETYPE_UNKNOWN;
  }
}

/**
 * The wasi_snapshot_preview1 import object for one run. SL-01 serves launch values, the three standard streams and
 * proc_exit; every other function returns its disposition's error (NOSYS while a later slice owns it), never success.
 */
export function preview1(host: Preview1Host, memory: () => GuestMemory, stdio: Stdio, launch: Launch): Readonly<Record<string, ImportFunction>> {
  const streams = [stdio.stdin, stdio.stdout, stdio.stderr] as const;
  const stream = (fd: number) => streams[fd];
  const failure = (error: unknown): WasiErrno => {
    if (error instanceof GuestFault) return WASI.fault;
    const errno = host.kit.errno.of(error);
    if (errno === undefined) throw error;
    return wasiErrno(errno);
  };
  const sizes = (list: readonly Uint8Array[], countOut: number, sizeOut: number): number => {
    const guest = memory();
    guest.setU32(countOut, list.length); guest.setU32(sizeOut, list.reduce((total, item) => total + item.byteLength, 0));
    return WASI.success;
  };
  const strings = (list: readonly Uint8Array[], pointers: number, buffer: number): number => {
    const guest = memory();
    let at = buffer;
    list.forEach((item, index) => { guest.setU32(pointers + index * 4, at); guest.write(at, item); at += item.byteLength; });
    return WASI.success;
  };
  /** Moves bytes through each checked vector in LIMITS.ioChunk pieces; stops at the first short transfer. */
  const transfer = (vectors: readonly IoVector[], progress: { total: number }, move: (vector: IoVector, offset: number, length: number) => number): void => {
    for (const vector of vectors) {
      for (let offset = 0; offset < vector.length; ) {
        const length = Math.min(LIMITS.ioChunk, vector.length - offset), moved = move(vector, offset, length);
        if (!Number.isInteger(moved) || moved < 0 || moved > length) throw new RangeError(`host moved ${String(moved)} of ${String(length)} bytes`);
        progress.total += moved; offset += moved;
        if (moved < length) return;
      }
    }
  };
  const io = (fd: number, list: number, count: number, out: number, move: (fd: NonNullable<ReturnType<typeof stream>>, vector: IoVector, offset: number, length: number) => number): number => {
    const target = stream(fd);
    if (target === undefined) return WASI.badf;
    let vectors: readonly IoVector[];
    try { vectors = memory().ioVectors(list, count); memory().check(out, 4); } catch (error) { return failure(error); }
    // A failure after some bytes moved reports the partial count, as Linux readv/writev do; the next call sees the error.
    const progress = { total: 0 };
    try { transfer(vectors, progress, (vector, offset, length) => move(target, vector, offset, length)); }
    catch (error) { const errno = failure(error); if (progress.total === 0) return errno; }
    memory().setU32(out, progress.total);
    return WASI.success;
  };
  const served: Partial<Record<Preview1Name, ImportFunction>> = {
    args_sizes_get: (count: number, size: number) => sizes(launch.argv, count, size),
    args_get: (pointers: number, buffer: number) => strings(launch.argv, pointers, buffer),
    environ_sizes_get: (count: number, size: number) => sizes(launch.environ, count, size),
    environ_get: (pointers: number, buffer: number) => strings(launch.environ, pointers, buffer),
    fd_read: (fd: number, list: number, count: number, out: number) => io(fd, list, count, out, (target, vector, offset, length) => {
      const bytes = host.fs.read(target, length);
      if (bytes.byteLength > length) throw new RangeError(`host returned ${String(bytes.byteLength)} bytes for a ${String(length)}-byte read`);
      memory().write(vector.pointer + offset, bytes);
      return bytes.byteLength;
    }),
    fd_write: (fd: number, list: number, count: number, out: number) => io(fd, list, count, out, (target, vector, offset, length) =>
      host.fs.write(target, memory().read(vector.pointer + offset, length))),
    fd_fdstat_get: (fd: number, out: number) => {
      const target = stream(fd);
      if (target === undefined) return WASI.badf;
      try {
        const guest = memory(), { mode } = host.fs.fstat(target);
        guest.check(out, 24);
        guest.write(out, new Uint8Array(24));
        guest.write(out, Uint8Array.of(filetype(mode)));
        // Rights of the standard streams: every Preview1 right (docs/contract.md); status flags arrive with SL-03.
        guest.setU64(out + 8, 0x1fffffffn); guest.setU64(out + 16, 0x1fffffffn);
        return WASI.success;
      } catch (error) { return failure(error); }
    },
    proc_exit: (code: number) => { throw new ProcExit(code >>> 0); },
    sched_yield: () => WASI.success,
  };
  return Object.fromEntries(PREVIEW1_IMPORTS.map(name => [name, served[name] ?? (() => PENDING[name] ?? WASI.nosys)]));
}
