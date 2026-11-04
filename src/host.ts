import type { BaseHost, Host } from "@oxidevm/sdk/wasm";
import type { FileDescriptor, LinuxFileStat, LinuxPath } from "@oxidevm/sdk/js-process";

/**
 * The host ports the WASI adapter uses. `AtFiles` mirrors the SDK's `files.at` capability (descriptor-relative,
 * positional and readiness operations, all synchronous and served by the engine's own Linux owners). Until that
 * capability ships in the SDK the module cannot declare it, so command.ts passes `at: undefined` and every operation
 * that needs it answers NOSYS.
 */
export interface LinuxDirent { readonly name: Uint8Array; readonly inode: bigint; readonly type: number; readonly next: bigint }
export interface AtFiles {
  readonly cwd: FileDescriptor;
  openat(dir: FileDescriptor, path: LinuxPath, flags: number, mode: number, resolve?: number): FileDescriptor;
  statAt(dir: FileDescriptor, path: LinuxPath, flags?: number): LinuxFileStat;
  mkdirAt(dir: FileDescriptor, path: LinuxPath, mode: number): void;
  unlinkAt(dir: FileDescriptor, path: LinuxPath, flags?: number): void;
  renameAt(fromDir: FileDescriptor, from: LinuxPath, toDir: FileDescriptor, to: LinuxPath, flags?: number): void;
  linkAt(fromDir: FileDescriptor, from: LinuxPath, toDir: FileDescriptor, to: LinuxPath, flags?: number): void;
  symlinkAt(target: LinuxPath, dir: FileDescriptor, path: LinuxPath): void;
  readlinkAt(dir: FileDescriptor, path: LinuxPath): Uint8Array;
  utimensAt(dir: FileDescriptor, path: LinuxPath, access: bigint | "now" | "omit", modification: bigint | "now" | "omit", flags?: number): void;
  pread(fd: FileDescriptor, count: number, offset: bigint): Uint8Array;
  pwrite(fd: FileDescriptor, bytes: Uint8Array, offset: bigint): number;
  statusFlags(fd: FileDescriptor): number;
  setStatusFlags(fd: FileDescriptor, flags: number): void;
  getdents(fd: FileDescriptor, maxBytes: number): readonly LinuxDirent[];
  fdatasync(fd: FileDescriptor): void;
  poll(entries: readonly { readonly fd: FileDescriptor; readonly events: 1 | 4 | 5 }[], timeoutMs: number): readonly { readonly fd: FileDescriptor; readonly revents: number }[];
}

/** A native child run to completion (SDK capability "process.sync", `runSync`). */
export interface NativeRunSpec {
  readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: Readonly<Record<string, string>>;
  readonly input: Uint8Array; readonly timeoutMs: number; readonly stdoutLimit: number; readonly stderrLimit: number;
}
export type NativeExit = { readonly kind: "exited"; readonly code: number } | { readonly kind: "signaled"; readonly signalNumber: number };
export interface NativeRunResult { readonly pid: number; readonly exit: NativeExit; readonly stdout: Uint8Array; readonly stderr: Uint8Array }
export interface ProcessSyncHost { runSync(spec: NativeRunSpec): NativeRunResult }

/** A synchronous VM socket connection (the SDK's NetSyncConnection). */
export interface SyncConnection {
  read(max: number, options?: { readonly timeoutMs?: number }): Uint8Array;
  write(bytes: Uint8Array): void;
  closeWrite(): void;
  close(): void;
}
/** VM sockets under the module's declared reach (SDK capabilities net.vm / net.internet). */
export interface NetSyncHost {
  connectSync(options: { readonly host: string; readonly port: number; readonly tls?: boolean; readonly alpn?: readonly string[] }): SyncConnection;
  connectUnixSync(path: string): SyncConnection;
  /** The Linux errno a network failure carries (kit.net.errno). */
  errno(error: unknown): number;
}

/** The VM's clocks (SDK capability "clock"): nanoseconds by the VM's own time, not the browser's. */
export interface ClockHost { now(clock: "realtime" | "monotonic"): bigint; resolution(clock: "realtime" | "monotonic"): bigint }
/** The VM's entropy (SDK capability "random"). */
export interface RandomHost { fill(bytes: Uint8Array): void }

export interface WasiHost {
  readonly kit: { readonly errno: Pick<BaseHost["kit"]["errno"], "of"> };
  readonly fs: Pick<Host<"files.sync">["fs"], "read" | "write" | "fstat" | "seek" | "close" | "fsync" | "ftruncate" | "pipe">;
  readonly at: AtFiles | undefined;
  readonly clock: ClockHost | undefined;
  readonly random: RandomHost | undefined;
}

/** Linux open(2) and *at(2) flag values the adapter passes. */
export const LINUX = {
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 0o100, O_EXCL: 0o200, O_TRUNC: 0o1000, O_APPEND: 0o2000, O_NONBLOCK: 0o4000,
  O_DSYNC: 0o10000, O_SYNC: 0o4010000, O_DIRECTORY: 0o200000, O_NOFOLLOW: 0o400000, O_CLOEXEC: 0o2000000, O_PATH: 0o10000000,
  AT_SYMLINK_NOFOLLOW: 0x100, AT_REMOVEDIR: 0x200, AT_SYMLINK_FOLLOW: 0x400, AT_EMPTY_PATH: 0x1000,
  RESOLVE_NO_MAGICLINKS: 2, RESOLVE_BENEATH: 8,
} as const;
