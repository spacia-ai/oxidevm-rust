// A typed stand-in for the host members the Rust adapter uses: three standard streams with an optional pipe capacity
// (so writes can be partial), Linux errors carried as `errno`, and `fail` writing its message to standard error. It
// models only what the adapter calls; every other member is absent, so the type checker rejects new uses.
import type { FileDescriptor, LinuxFileStat, LinuxProcessInfo } from "@oxidevm/sdk/js-process";

type ProcessId = LinuxProcessInfo["pid"];
import type { RustCommandHost } from "../../src/command.ts";
import type { FakeFiles } from "./files.ts";
import type { ClockHost, NetSyncHost, ProcessSyncHost, RandomHost } from "../../src/host.ts";

export class FakeLinuxError extends Error {
  constructor(readonly errno: number) { super(`errno ${String(errno)}`); }
}
function isDescriptor(value: number): value is FileDescriptor { return Number.isInteger(value) && value >= 0; }
function isProcessId(value: number): value is ProcessId { return Number.isInteger(value) && value > 0; }
function descriptorPid(value: number): ProcessId { if (!isProcessId(value)) throw new RangeError(`not a pid: ${String(value)}`); return value; }
export function descriptor(value: number): FileDescriptor {
  if (!isDescriptor(value)) throw new RangeError(`not a descriptor: ${String(value)}`);
  return value;
}

export interface StreamsOptions {
  /** Files behind files.at and the file members of files.sync; absent, as on an SDK without files.at. */
  readonly files?: FakeFiles;
  readonly clock?: ClockHost;
  readonly processSync?: ProcessSyncHost;
  readonly netSync?: NetSyncHost;
  readonly random?: RandomHost;
  /** The mode fstat reports for every stream (default a FIFO). */
  readonly mode?: number;
  readonly stdin?: Uint8Array;
  /** The most bytes one write to stdout accepts; a smaller value forces partial writes. */
  readonly stdoutCapacity?: number;
  /** stdout's reader has gone: writes fail with EPIPE (32), as when SIGPIPE is ignored. */
  readonly stdoutClosed?: boolean;
}
export interface Streams {
  readonly host: RustCommandHost;
  readonly stdout: () => Uint8Array;
  readonly stderr: () => string;
  readonly writes: () => readonly number[];
}

export function streams(options: StreamsOptions = {}): Streams {
  let input = options.stdin ?? new Uint8Array();
  const output: [Uint8Array[], Uint8Array[]] = [[], []], counts: number[] = [];
  const stat = (mode: number): LinuxFileStat => ({ device: 0n, inode: 1n, links: 1n, mode, uid: 1000, gid: 1000, size: 0n, accessedNs: 0n, modifiedNs: 0n, changedNs: 0n });
  const host: RustCommandHost = {
    kit: { errno: { of: error => error instanceof FakeLinuxError ? error.errno : undefined } },
    fail(status, message) { output[1].push(new TextEncoder().encode(`${message}\n`)); return status; },
    fs: {
      read(fd, count) {
        if (options.files?.owns(fd) === true) return options.files.read(fd, count);
        if (fd !== 0) throw new FakeLinuxError(9);
        const chunk = input.slice(0, count); input = input.slice(chunk.byteLength); return chunk;
      },
      write(fd, bytes) {
        if (options.files?.owns(fd) === true) return options.files.write(fd, bytes);
        if (fd !== 1 && fd !== 2) throw new FakeLinuxError(9);
        if (fd === 1 && options.stdoutClosed === true) throw new FakeLinuxError(32);
        const accepted = fd === 1 ? bytes.subarray(0, options.stdoutCapacity ?? bytes.byteLength) : bytes;
        output[fd - 1]?.push(accepted.slice()); counts.push(accepted.byteLength);
        return accepted.byteLength;
      },
      fstat: fd => options.files?.owns(fd) === true ? options.files.stat(options.files.fileOf(fd).path) : stat(options.mode ?? 0o010600),
      seek: (fd, offset, origin = "start") => { if (options.files?.owns(fd) === true) return options.files.seek(fd, offset, origin); throw new FakeLinuxError(29); },
      close: fd => { if (options.files?.owns(fd) === true) options.files.close(fd); },
      fsync: () => undefined,
      pipe: () => { throw new FakeLinuxError(24); },
      ftruncate: (fd, length) => { if (options.files?.owns(fd) === true) { options.files.truncate(fd, BigInt(length)); return; } throw new FakeLinuxError(22); },
    },
    at: options.files?.at,
    processSync: options.processSync,
    netSync: options.netSync,
    clock: options.clock,
    random: options.random,
    process: { info: () => Promise.resolve({ pid: descriptorPid(42), parentPid: descriptorPid(7), uid: 1000, gid: 1000, cwd: "/workspace", args: [], environment: [], terminal: null }) },
  };
  const join = (parts: readonly Uint8Array[]): Uint8Array => {
    const all = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0)); let at = 0;
    for (const part of parts) { all.set(part, at); at += part.byteLength; }
    return all;
  };
  return { host, stdout: () => join(output[0]), stderr: () => new TextDecoder().decode(join(output[1])), writes: () => counts };
}
