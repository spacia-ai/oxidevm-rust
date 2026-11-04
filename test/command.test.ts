import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandIO } from "@oxidevm/sdk/wasm";
import { rustCommand, type RustCommandName } from "../src/command.ts";
import { descriptor, streams, type StreamsOptions } from "./support/streams.ts";

/** The pinned Rust program (the hello fixture built for wasm32-wasip1), and the binary-echo fixture when it is built. */
const hello = new WebAssembly.Module(await readFile(new URL("../upstream/bridge-demo.wasm", import.meta.url)));
const echoFile = new URL("../target/wasm32-wasip1/release/fixture-binary-echo.wasm", import.meta.url);
const echo = await readFile(echoFile).then(bytes => new WebAssembly.Module(bytes), () => undefined);

function io(args: readonly string[], argv0?: string, env: Readonly<Record<string, string>> = {}): CommandIO<RustCommandName> {
  return {
    args, env, cwd: "/workspace", stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2),
    invocation: argv0 === undefined ? { kind: "host" } : { kind: "command", name: "rust-bridge-demo", path: "/usr/local/bin/rust-bridge-demo", argv0 },
    terminals: { stdin: false, stdout: false, stderr: false },
  };
}
async function run(program: WebAssembly.Module, args: readonly string[], argv0?: string, options: StreamsOptions = {}) {
  const fake = streams(options);
  const status = await rustCommand(fake.host, program, "rust-bridge-demo").main(io(args, argv0));
  return { status, stdout: new TextDecoder().decode(fake.stdout()), stdoutBytes: fake.stdout(), stderr: fake.stderr(), writes: fake.writes() };
}

describe("the pinned Rust command (OBL-TEMPLATE, OBL-ARGS)", () => {
  it("runs the Rust program with argv0 and its arguments exactly", async () => {
    expect(await run(hello, ["", "--x", "two words", "zażółć"], "/usr/local/bin/rust-bridge-demo")).toMatchObject({
      status: 0, stdout: `hello from rust wasm: ["/usr/local/bin/rust-bridge-demo", "", "--x", "two words", "zażółć"]\n`, stderr: "",
    });
  });

  it("names itself rust-bridge-demo when the application starts it", async () => {
    expect((await run(hello, [])).stdout).toBe(`hello from rust wasm: ["rust-bridge-demo"]\n`);
  });

  it("returns the program's exit status exactly up to 119", async () => {
    expect((await run(hello, ["--exit", "7"])).status).toBe(7);
    expect((await run(hello, ["--exit", "119"])).status).toBe(119);
  });

  it("reports a larger exit status as 1 and names the original (OBL-EXIT)", async () => {
    const result = await run(hello, ["--exit", "200"], "rust-bridge-demo");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("exited with status 200");
  });

  it("refuses an over-long launch before the program starts", async () => {
    const result = await run(hello, ["a".repeat(70 * 1024)]);
    expect(result).toMatchObject({ status: 2, stdout: "" });
    expect(result.stderr).toContain("argv exceeds 65536 bytes");
  });

  it("gives every run a fresh instance (OBL-FRESH-STATE, unit level)", async () => {
    const first = streams();
    const command = rustCommand(first.host, hello, "rust-bridge-demo");
    expect(await command.main(io(["one"]))).toBe(0);
    expect(await command.main(io(["two"]))).toBe(0);
    expect(new TextDecoder().decode(first.stdout())).toBe(`hello from rust wasm: ["rust-bridge-demo", "one"]\nhello from rust wasm: ["rust-bridge-demo", "two"]\n`);
  });
});

describe.skipIf(echo === undefined)("binary streams (OBL-BINARY-IO, OBL-PARTIAL-IO; needs pnpm run build:rust)", () => {
  const every = Uint8Array.from({ length: 4 * 256 }, (_, index) => index % 256);

  it("copies every byte value, NUL included, from stdin to stdout", async () => {
    if (echo === undefined) return;
    const result = await run(echo, [], undefined, { stdin: every });
    expect(result.status).toBe(0);
    expect(result.stdoutBytes).toEqual(every);
    expect(result.stderr).toBe("binary-echo: 1024 bytes\n");
  });

  it("keeps order across partial writes and never spins on zero progress", async () => {
    if (echo === undefined) return;
    const result = await run(echo, [], undefined, { stdin: every, stdoutCapacity: 7 });
    expect(result.stdoutBytes).toEqual(every);
    expect(result.writes.every(count => count > 0)).toBe(true);
  });

  it("reports EPIPE as a write error when SIGPIPE does not end the process", async () => {
    if (echo === undefined) return;
    const result = await run(echo, [], undefined, { stdin: every, stdoutClosed: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^binary-echo: Broken pipe/u);
  });
});
