import type { BaseHost, Host, Stdio, Terminals } from "@oxidevm/sdk/wasm";
import { WASI, wasiErrno, type WasiErrno } from "../errno.ts";
import { LIMITS } from "../limits.ts";
import { GuestFault, type GuestMemory, type IoVector } from "../memory.ts";
import { PREVIEW1_IMPORTS, type Preview1Name } from "./imports.ts";
import { filetypeOf, streamRights, writeFilestat } from "./stat.ts";

/** What the Preview1 imports use: the process's own Linux streams and the kit's errno reader, nothing more. */
export interface Preview1Host {
  readonly kit: { readonly errno: Pick<BaseHost["kit"]["errno"], "of"> };
  readonly fs: Pick<Host<"files.sync">["fs"], "read" | "write" | "fstat" | "stat" | "lstat">;
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

/** A path the profile refuses before any host call: NUL inside, longer than 4095 bytes, or not UTF-8 (`ilseq`). */
class PathRefusal extends Error {
  override readonly name = "PathRefusal";
  constructor(readonly errno: WasiErrno) { super(`path refused with WASI errno ${String(errno)}`); }
}
const UTF8 = new TextDecoder("utf-8", { fatal: true });
/** The absolute path of `bytes` beneath the root preopen, or the errno that refuses it. */
export function rootPath(bytes: Uint8Array): string | WasiErrno {
  if (bytes.byteLength > MAX_PATH_BYTES) return WASI.nametoolong;
  if (bytes.includes(0)) return WASI.inval;
  let text: string;
  try { text = UTF8.decode(bytes); } catch { return WASI.ilseq; }
  return text.startsWith("/") ? text : `/${text}`;
}

/** What each Preview1 function does before its slice implements it: the disposition table's explicit error. */
const PENDING: Readonly<Partial<Record<Preview1Name, WasiErrno>>> = {
  fd_advise: WASI.notsup, fd_allocate: WASI.notsup,
  sock_accept: WASI.badf, sock_recv: WASI.badf, sock_send: WASI.badf, sock_shutdown: WASI.badf,
};

/**
 * The first descriptor after the standard streams is the root preopen: the VM's whole tree, under the process's own
 * Linux credentials, as a native program of the caller has it. A path beneath it is therefore the absolute path the
 * engine resolves; the adapter joins, it never resolves or checks.
 */
const ROOT_PREOPEN = 3;
const LOOKUP_SYMLINK_FOLLOW = 1;
const MAX_PATH_BYTES = 4095;

/**
 * The wasi_snapshot_preview1 import object for one run. SL-01 serves launch values, the three standard streams and
 * proc_exit; every other function returns its disposition's error (NOSYS while a later slice owns it), never success.
 */
export function preview1(host: Preview1Host, memory: () => GuestMemory, stdio: Stdio, launch: Launch, terminals: Terminals): Readonly<Record<string, ImportFunction>> {
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
  const guarded = (body: () => void): WasiErrno => {
    try { body(); return WASI.success; } catch (error) { if (error instanceof PathRefusal) return error.errno; return failure(error); }
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
        const guest = memory(), type = filetypeOf(host.fs.fstat(target).mode);
        const terminal = [terminals.stdin, terminals.stdout, terminals.stderr][fd] ?? false;
        guest.check(out, 24);
        guest.write(out, new Uint8Array(24));
        guest.write(out, Uint8Array.of(type));
        // Status flags arrive with SL-03; rights follow the stream's type so `IsTerminal` agrees with Linux.
        guest.setU64(out + 8, streamRights(type, terminal)); guest.setU64(out + 16, streamRights(type, terminal));
        return WASI.success;
      } catch (error) { return failure(error); }
    },
    fd_filestat_get: (fd: number, out: number) => {
      const target = stream(fd);
      if (target === undefined) return fd === ROOT_PREOPEN ? guarded(() => { writeFilestat(memory(), out, host.fs.stat("/")); }) : WASI.badf;
      return guarded(() => { writeFilestat(memory(), out, host.fs.fstat(target)); });
    },
    fd_prestat_get: (fd: number, out: number) => {
      if (fd !== ROOT_PREOPEN) return WASI.badf;
      return guarded(() => { const guest = memory(); guest.check(out, 8); guest.setU32(out, 0); guest.setU32(out + 4, 1); });
    },
    fd_prestat_dir_name: (fd: number, buffer: number, length: number) => {
      if (fd !== ROOT_PREOPEN) return WASI.badf;
      if (length < 1) return WASI.nametoolong;
      return guarded(() => { memory().write(buffer, Uint8Array.of(0x2f)); });
    },
    path_filestat_get: (fd: number, flags: number, path: number, length: number, out: number) => {
      if (fd !== ROOT_PREOPEN) return stream(fd) === undefined ? WASI.badf : WASI.notdir;
      return guarded(() => {
        const absolute = rootPath(memory().read(path, length));
        if (typeof absolute === "number") throw new PathRefusal(absolute);
        writeFilestat(memory(), out, (flags & LOOKUP_SYMLINK_FOLLOW) !== 0 ? host.fs.stat(absolute) : host.fs.lstat(absolute));
      });
    },
    proc_exit: (code: number) => { throw new ProcExit(code >>> 0); },
    sched_yield: () => WASI.success,
  };
  return Object.fromEntries(PREVIEW1_IMPORTS.map(name => [name, served[name] ?? (() => PENDING[name] ?? WASI.nosys)]));
}
