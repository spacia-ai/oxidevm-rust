import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandIO } from "@oxidevm/sdk/wasm";
import { decodeRequest } from "../src/bridge/command.ts";
import { rustCommand, type RustCommandName } from "../src/command.ts";
import type { NativeRunResult, NativeRunSpec, ProcessSyncHost } from "../src/host.ts";
import { WasiError } from "../src/wasi/context.ts";
import { descriptor, FakeLinuxError, streams } from "./support/streams.ts";

const demo = new WebAssembly.Module(await readFile(new URL("../upstream/bridge-demo.wasm", import.meta.url)));
const every = Uint8Array.from({ length: 512 }, (_, index) => index % 256);

function io(args: readonly string[]): CommandIO<RustCommandName> {
  return { args, env: { HOME: "/workspace" }, cwd: "/workspace", stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), invocation: { kind: "host" }, terminals: { stdin: false, stdout: false, stderr: false } };
}
async function run(args: readonly string[], processSync: ProcessSyncHost | undefined, stdin = new Uint8Array()) {
  const fake = streams({ stdin, ...(processSync === undefined ? {} : { processSync }) });
  const status = await rustCommand(fake.host, demo, "rust-bridge-demo").main(io(args));
  return { status, stdout: fake.stdout(), stderr: fake.stderr() };
}

describe("native children through the bridge (OBL-NATIVE-OUTPUT, OBL-CHILD-STATUS; unit level)", () => {
  it("sends binary input and returns binary output, the real pid and an exact status", async () => {
    const seen: NativeRunSpec[] = [];
    const host: ProcessSyncHost = { runSync: spec => { seen.push(spec); return { pid: 77, exit: { kind: "exited", code: 255 }, stdout: spec.input.slice().reverse(), stderr: Uint8Array.of(0) }; } };
    const result = await run(["run", "/bin/gzip", "-c", "two words"], host, every);
    expect(seen[0]).toMatchObject({ command: "/bin/gzip", args: ["-c", "two words"], timeoutMs: 30_000, stdoutLimit: 1024 * 1024, stderrLimit: 1024 * 1024 });
    expect(seen[0]?.input).toEqual(every);
    expect(result.stdout).toEqual(every.slice().reverse());
    expect(result.stderr).toBe("\0rust-bridge-demo: child 77 Exited(255)\n");
    expect(result.status).toBe(119);
  });

  it("reports a signal death as a tagged status", async () => {
    const host: ProcessSyncHost = { runSync: () => ({ pid: 8, exit: { kind: "signaled", signalNumber: 9 }, stdout: new Uint8Array(), stderr: new Uint8Array() }) };
    const result = await run(["run", "/bin/sh", "-c", "kill -9 $$"], host);
    expect(result.stderr).toBe("rust-bridge-demo: child 8 Signaled(9)\n");
    expect(result.status).toBe(109);
  });

  it("maps a timeout and an output limit to typed errors", async () => {
    const failing = (errno: number): ProcessSyncHost => ({ runSync: (): NativeRunResult => { throw new FakeLinuxError(errno); } });
    expect((await run(["run", "/bin/sleep", "600"], failing(110))).stderr).toBe("rust-bridge-demo: the native command ran past its deadline and was killed\n");
    expect((await run(["run", "/bin/yes"], failing(7))).stderr).toBe("rust-bridge-demo: the native command exceeded its output limit and was killed\n");
  });

  it("is unavailable without process.sync, and nothing runs (OBL-NATIVE-DENIED)", async () => {
    const result = await run(["run", "/bin/true"], undefined);
    expect(result).toMatchObject({ status: 1, stderr: "rust-bridge-demo: the OxideVM bridge is not available to this program\n" });
  });
});

describe("command request decoding (OBL-NATIVE-VALIDATE)", () => {
  type Part = number | string | Uint8Array | { readonly u8: 0 | 1 };
  const N: Part = { u8: 0 }, Y: Part = { u8: 1 };
  const encode = (parts: readonly Part[]) => {
    const out: number[] = [];
    const u32 = (value: number) => { out.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, value >>> 24); };
    for (const part of parts) {
      if (typeof part === "object" && "u8" in part) out.push(part.u8);
      else if (typeof part === "number") u32(part);
      else { const bytes = typeof part === "string" ? new TextEncoder().encode(part) : part; u32(bytes.byteLength); out.push(...bytes); }
    }
    return Uint8Array.from(out);
  };
  const valid = ["/bin/x", 1, "a", N, N, new Uint8Array(), 1000, 10, 10] as const;
  const refused = (parts: readonly Part[]) => { try { decodeRequest(encode(parts)); return false; } catch (error) { return error instanceof WasiError; } };

  it("accepts a valid request exactly and refuses every broken bound before anything runs", () => {
    expect(decodeRequest(encode(valid))).toEqual({ command: "/bin/x", args: ["a"], input: new Uint8Array(), timeoutMs: 1000, stdoutLimit: 10, stderrLimit: 10 });
    expect(refused(["bin/x", 0, N, N, new Uint8Array(), 1000, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 64, ...Array.from({ length: 64 }, () => "a"), N, N, new Uint8Array(), 1000, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 1, "a\0b", N, N, new Uint8Array(), 1000, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 0, N, N, new Uint8Array(), 0, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 0, N, N, new Uint8Array(), 180_001, 10, 10])).toBe(true);
    expect(refused(["/bin/x", 0, N, N, new Uint8Array(), 1000, 1024 * 1024 + 1, 10])).toBe(true);
    expect(refused(["/bin/x", 0, N, Y, 1, "=v", new Uint8Array(), 1000, 10, 10])).toBe(true);
    expect(refused([...valid, 0])).toBe(true);
    expect(refused(valid.slice(0, -1))).toBe(true);
  });
});
