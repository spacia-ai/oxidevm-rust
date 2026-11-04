import type { FileDescriptor } from "@oxidevm/sdk/js-process";
import { WASI } from "../errno.ts";
import { WasiError } from "./context-error.ts";

/**
 * One guest descriptor. `host` is the Linux descriptor it names; `owned` says whether closing the guest descriptor
 * closes the Linux one (the process's standard streams are not owned: the runner still writes diagnostics to them).
 * `confined` marks descriptors opened beneath a restricted preopen: path operations through them resolve with
 * RESOLVE_BENEATH, by the engine.
 */
export type Entry =
  | { readonly kind: "stream"; readonly host: FileDescriptor; readonly terminal: boolean; base: bigint; inheriting: bigint; readonly owned: false; readonly confined: false }
  | { readonly kind: "preopen"; readonly host: FileDescriptor; readonly name: Uint8Array; base: bigint; inheriting: bigint; readonly owned: true; readonly confined: boolean }
  | { readonly kind: "file" | "directory"; readonly host: FileDescriptor; base: bigint; inheriting: bigint; readonly owned: true; readonly confined: boolean };

/**
 * The guest descriptor table of one run: at most `limit` entries (standard streams and preopens included). A guest
 * number names exactly one entry until it is closed or renumbered; a stale or guessed number is BADF, never a Linux
 * descriptor. Each owned Linux descriptor is closed exactly once.
 */
export class DescriptorTable {
  readonly #entries = new Map<number, Entry>();
  readonly #limit: number;
  readonly #close: (fd: FileDescriptor) => void;

  constructor(limit: number, close: (fd: FileDescriptor) => void) {
    this.#limit = limit; this.#close = close;
  }

  get size(): number { return this.#entries.size; }

  /** The entry for a guest number, or BADF. */
  get(fd: number): Entry {
    const entry = this.#entries.get(fd);
    if (entry === undefined) throw new WasiError(WASI.badf);
    return entry;
  }

  /** The entry, checked to hold every right in `needed` (NOTCAPABLE otherwise). */
  require(fd: number, needed: bigint): Entry {
    const entry = this.get(fd);
    if ((entry.base & needed) !== needed) throw new WasiError(WASI.notcapable);
    return entry;
  }

  /** Places an entry at the lowest free number; MFILE (after closing an owned Linux descriptor) when the table is full. */
  insert(entry: Entry): number {
    if (this.#entries.size >= this.#limit) {
      if (entry.owned) this.#close(entry.host);
      throw new WasiError(WASI.mfile);
    }
    let fd = 0;
    while (this.#entries.has(fd)) fd += 1;
    this.#entries.set(fd, entry);
    return fd;
  }

  /** Places an entry at an exact number (standard streams and preopens at start-up). */
  place(fd: number, entry: Entry): void {
    if (this.#entries.has(fd) || this.#entries.size >= this.#limit) throw new WasiError(WASI.mfile);
    this.#entries.set(fd, entry);
  }

  close(fd: number): void {
    const entry = this.get(fd);
    this.#entries.delete(fd);
    if (entry.owned) this.#close(entry.host);
  }

  /** WASI fd_renumber: `to` must be open; it is closed and `from` takes its number. */
  renumber(from: number, to: number): void {
    const moving = this.get(from), replaced = this.get(to);
    if (from === to) return;
    this.#entries.delete(from);
    this.#entries.set(to, moving);
    if (replaced.owned) this.#close(replaced.host);
  }

  /** Closes every owned descriptor that is still open (the run ended). */
  closeAll(): void {
    for (const entry of this.#entries.values()) if (entry.owned) { try { this.#close(entry.host); } catch { /* already gone with the process */ } }
    this.#entries.clear();
  }
}
