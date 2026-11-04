import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandIO } from "@oxidevm/sdk/wasm";
import { rustCommand, type RustCommandName } from "../src/command.ts";
import { FakeFiles } from "./support/files.ts";
import { descriptor, streams } from "./support/streams.ts";

const probeFile = new URL("../target/wasm32-wasip1/release/fixture-import-probe.wasm", import.meta.url);
const probe = await readFile(probeFile).then(bytes => new WebAssembly.Module(bytes), () => undefined);

function io(args: readonly string[], env: Readonly<Record<string, string>>): CommandIO<RustCommandName> {
  return {
    args, env, cwd: "/workspace", stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2),
    invocation: { kind: "host" }, terminals: { stdin: false, stdout: false, stderr: false },
  };
}

describe.skipIf(probe === undefined)("Rust std::fs through the adapter (SL-04, unit level; needs pnpm run build:rust)", () => {
  it("runs every std file probe against the host's files", async () => {
    if (probe === undefined) return;
    const files = new FakeFiles({}, ["/workspace", "/workspace/t"]);
    const fake = streams({ files });
    const probes = ["fs_write_read", "fs_append_seek", "fs_metadata", "fs_create_dir_read_dir", "fs_rename", "fs_hard_link", "fs_set_len_sync", "fs_remove"];
    expect(await rustCommand(fake.host, probe, "rust-bridge-demo").main(io(probes, { PROBE_DIR: "/workspace/t" }))).toBe(0);
    const lines = new TextDecoder().decode(fake.stdout()).trim().split("\n");
    expect(lines).toEqual([
      "fs_write_read: ok 11 bytes",
      "fs_append_seek: ok 12 bytes",
      "fs_metadata: ok len=12 modified=true",
      'fs_create_dir_read_dir: ok ["a"]',
      "fs_rename: ok renamed",
      "fs_hard_link: ok linked",
      "fs_set_len_sync: ok truncated and synced",
      "fs_remove: ok removed",
    ]);
    // Everything went through descriptor-relative calls on the held root preopen; nothing was resolved by the adapter.
    const opens = files.calls.filter(call => call.op === "openat");
    expect(opens[0]?.args).toEqual([-100, "/", 0o10000000 | 0o200000 | 0o2000000, 0, 0]);
    expect(opens.slice(1).every(call => { const name = call.args[1]; return typeof name === "string" && !name.startsWith("/") && call.args[4] === 0; })).toBe(true);
    // Every descriptor the program opened was closed again (the run's table closes what the program left open).
    expect(files.open.size).toBe(0);
  });

  it("reads a symbolic link a native program created", async () => {
    if (probe === undefined) return;
    const files = new FakeFiles({ "/workspace/t/probe.txt": "x" }, ["/workspace", "/workspace/t"]);
    files.at.symlinkAt("probe.txt", files.at.cwd, "t/probe.link");
    const fake = streams({ files });
    expect(await rustCommand(fake.host, probe, "rust-bridge-demo").main(io(["fs_read_link"], { PROBE_DIR: "/workspace/t" }))).toBe(0);
    expect(new TextDecoder().decode(fake.stdout())).toBe("fs_read_link: ok probe.txt\n");
  });
});

describe.skipIf(probe === undefined)("Rust std time and randomness through the adapter (SL-05, unit level)", () => {
  it("reads the VM clock, sleeps through one engine wait and seeds HashMap from VM entropy", async () => {
    if (probe === undefined) return;
    let now = 1_700_000_000_000_000_000n;
    const waits: number[] = [];
    const files = new FakeFiles({}, ["/workspace"]);
    const at = { ...files.at, poll: (_entries: unknown, timeout: number) => { waits.push(timeout); now += BigInt(timeout) * 1_000_000n; return []; } };
    const base = streams({ files, clock: { now: () => now, resolution: () => 1n }, random: { fill: bytes => { bytes.fill(1); } } });
    let next = 200;
    const host = { ...base.host, at, fs: { ...base.host.fs, pipe: () => [descriptor(next++), descriptor(next++)] as const, close: (fd: Parameters<typeof base.host.fs.close>[0]) => { if (fd < 200) base.host.fs.close(fd); } } };
    expect(await rustCommand(host, probe, "rust-bridge-demo").main(io(["time_system", "time_sleep", "random_hashmap"], {}))).toBe(0);
    expect(new TextDecoder().decode(base.stdout()).trim().split("\n")).toEqual(["time_system: ok 1700000000s", "time_sleep: ok 50ms", "random_hashmap: ok 1 entries"]);
    expect(waits).toEqual([50]);
  });
});
