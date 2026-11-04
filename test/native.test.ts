import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandIO } from "@oxidevm/sdk/wasm";
import { rustCommand, type RustCommandName } from "../src/command.ts";
import type { NativeSyncRunResult as NativeRunResult, NativeSyncRunSpec as NativeRunSpec, ProcessSync } from "@oxidevm/sdk/js-process";
import { descriptor, FakeLinuxError, processId, streams } from "./support/streams.ts";

const demo = new WebAssembly.Module(await readFile(new URL("../upstream/bridge-demo.wasm", import.meta.url)));
const every = Uint8Array.from({ length: 512 }, (_, index) => index % 256);

function io(args: readonly string[]): CommandIO<RustCommandName> {
  return { args, env: { HOME: "/workspace" }, cwd: "/workspace", stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), invocation: { kind: "host" }, terminals: { stdin: false, stdout: false, stderr: false } };
}
type ProcessSyncHost = Pick<ProcessSync, "runSync">;
async function run(args: readonly string[], processSync: ProcessSyncHost | undefined, stdin = new Uint8Array()) {
  const fake = streams({ stdin, ...(processSync === undefined ? {} : { processSync }) });
  const status = await rustCommand(fake.host, demo).main(io(args));
  return { status, stdout: fake.stdout(), stderr: fake.stderr() };
}

describe("native children through the bridge (OBL-NATIVE-OUTPUT, OBL-CHILD-STATUS; unit level)", () => {
  it("sends binary input and returns binary output, the real pid and an exact status", async () => {
    const seen: NativeRunSpec[] = [];
    const host: ProcessSyncHost = { runSync: spec => { seen.push(spec); return { pid: processId(77), exit: { kind: "exited", code: 255 }, stdout: (spec.input ?? new Uint8Array()).slice().reverse(), stderr: Uint8Array.of(0) }; } };
    const result = await run(["run", "/bin/gzip", "-c", "two words"], host, every);
    expect(seen[0]).toMatchObject({ command: "/bin/gzip", args: ["-c", "two words"], timeoutMs: 30_000, stdoutLimit: 1024 * 1024, stderrLimit: 1024 * 1024 });
    expect(seen[0]?.input).toEqual(every);
    expect(result.stdout).toEqual(every.slice().reverse());
    expect(result.stderr).toBe("\0rust-bridge-demo: child 77 Exited(255)\n");
    expect(result.status).toBe(119);
  });

  it("reports a signal death as a tagged status", async () => {
    const host: ProcessSyncHost = { runSync: () => ({ pid: processId(8), exit: { kind: "signaled", signal: "SIGKILL", signalNumber: 9 }, stdout: new Uint8Array(), stderr: new Uint8Array() }) };
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

describe("rust-bridge-demo summarize (the SL-09 example program)", () => {
  it("totals per country, writes the summary atomically, compresses it natively and verifies the round trip", async () => {
    const { FakeFiles } = await import("./support/files.ts");
    const files = new FakeFiles({ "/workspace/data.csv": "order_id,country,total\n1,Netherlands,149\n2,Germany,119\n3,France,99\n4,Netherlands,150\n5,United Kingdom,129\n6,Germany,120\n7,France,90\n8,Netherlands,150\n" }, ["/workspace"]);
    const calls: string[][] = [];
    // A reversible stand-in for gzip: -c reverses the bytes, -d -c reverses them back.
    const gzip: ProcessSyncHost = { runSync: spec => { calls.push([spec.command, ...(spec.args ?? [])]); return { pid: processId(40 + calls.length), exit: { kind: "exited", code: 0 }, stdout: (spec.input ?? new Uint8Array()).slice().reverse(), stderr: new Uint8Array() }; } };
    const fake = streams({ files, processSync: gzip });
    const status = await rustCommand(fake.host, demo).main(io(["summarize", "data.csv", "summary.csv"]));
    expect(status).toBe(0);
    const summary = "country,orders,total\nFrance,2,189\nGermany,2,239\nNetherlands,3,449\nUnited Kingdom,1,129\n";
    expect(new TextDecoder().decode(files.tree.get("/workspace/summary.csv")?.data)).toBe(summary);
    expect(files.tree.has("/workspace/summary.csv.tmp")).toBe(false);
    expect(files.tree.get("/workspace/summary.csv.gz")?.data).toEqual(new TextEncoder().encode(summary).reverse());
    expect(calls).toEqual([["/bin/gzip", "-n", "-c"], ["/bin/gzip", "-d", "-c"]]);
    expect(new TextDecoder().decode(fake.stdout())).toBe(`summary: 4 countries, ${String(summary.length)} bytes; rust pid 42; gzip pid 41 wrote ${String(summary.length)} bytes; gzip -d pid 42 round trip ok\n`);
  });
});
