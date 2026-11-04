// Compile-time regressions (OBL-STRICT): `tsc -p test` must report each line below as an error. If a change makes one of
// them type-check, the unused @ts-expect-error fails the build, so a widened boundary cannot slip in unnoticed.
import type { RustCommandHost } from "../src/command.ts";
import type { Preview1Host } from "../src/wasi/preview1.ts";
import { GuestMemory } from "../src/memory.ts";

declare const host: RustCommandHost;
declare const untrusted: unknown;

export function negatives(): void {
  // @ts-expect-error -- the command host has no process member until the manifest declares process capabilities (SL-06).
  void host.process;
  // @ts-expect-error -- nor a network member: the base module is not given any reach (SL-07 adds net.vm).
  void host.net;
  // @ts-expect-error -- a plain number is not a Linux descriptor; descriptors come from the host.
  host.fs.read(3, 1);
  // @ts-expect-error -- untrusted values must be decoded before use as guest memory.
  new GuestMemory(untrusted);
  const preview: Preview1Host = host;
  // @ts-expect-error -- the Preview1 imports get only read/write/fstat of the Linux file facade.
  void preview.fs.open;
}
