import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandIO } from "@oxidevm/sdk/wasm";
import { rustCommand, type RustCommandName } from "../src/command.ts";
import { parseRunnerArguments } from "../src/runner.ts";
import { FakeFiles } from "./support/files.ts";
import { descriptor, streams } from "./support/streams.ts";
import { wasm } from "./wasm-builder.ts";

const demoBytes = new Uint8Array(await readFile(new URL("../upstream/bridge-demo.wasm", import.meta.url)));
const demo = new WebAssembly.Module(demoBytes);
const io = (args: readonly string[], cwd = "/workspace"): CommandIO<RustCommandName> => ({
  args, env: {}, cwd, stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2),
  invocation: { kind: "command", name: "rust-wasi", path: "/usr/local/bin/rust-wasi", argv0: "rust-wasi" }, terminals: { stdin: false, stdout: false, stderr: false },
});
async function runWasi(args: readonly string[], programs: Readonly<Record<string, Uint8Array>>, cwd?: string) {
  const fake = streams({ programs, files: new FakeFiles({}, ["/workspace", "/srv"]) });
  const status = await rustCommand(fake.host, demo, "rust-bridge-demo").main(io(args, cwd));
  return { status, stdout: new TextDecoder().decode(fake.stdout()), stderr: fake.stderr() };
}

describe("rust-wasi (OBL-RUNNER, OBL-ARGS runner mode)", () => {
  it("runs a local program with its own argv0 and arguments; one -- after the program is dropped", async () => {
    expect(await runWasi(["/workspace/tool.wasm", "--", "alpha", "--", "-x"], { "/workspace/tool.wasm": demoBytes })).toEqual({
      status: 0, stdout: 'hello from rust wasm: ["/workspace/tool.wasm", "alpha", "--", "-x"]\n', stderr: "",
    });
  });

  it("prints help and version", async () => {
    expect((await runWasi(["--help"], {})).stdout).toMatch(/^usage: rust-wasi /u);
    expect((await runWasi(["--version"], {})).stdout).toBe("rust-wasi 0.0.0\n");
  });

  it("refuses missing, malformed and unsupported programs before any of their code runs", async () => {
    expect(await runWasi(["/workspace/none.wasm"], {})).toMatchObject({ status: 1, stderr: "rust-wasi: cannot read /workspace/none.wasm: Linux errno 2\n" });
    expect((await runWasi(["/workspace/bad.wasm"], { "/workspace/bad.wasm": Uint8Array.of(1, 2, 3) })).stderr).toBe("rust-wasi: /workspace/bad.wasm is not a WebAssembly binary\n");
    expect((await runWasi(["/workspace/start.wasm"], { "/workspace/start.wasm": wasm({ start: true }) })).stderr).toBe("rust-wasi: /workspace/start.wasm has a start section\n");
    expect((await runWasi(["/workspace/js.wasm"], { "/workspace/js.wasm": wasm({ functionImports: [["env", "emscripten_memcpy_js"]] }) })).stderr).toMatch(/unknown namespace env/u);
    expect((await runWasi(["/workspace/big.wasm"], { "/workspace/big.wasm": new Uint8Array(32 * 1024 * 1024 + 1) })).stderr).toMatch(/larger than 33554432 bytes/u);
  });

  it("refuses to start in a directory no --dir grants", async () => {
    expect(await runWasi(["--dir", "/srv:ro", "/workspace/tool.wasm"], { "/workspace/tool.wasm": demoBytes }, "/workspace")).toMatchObject({
      status: 2, stdout: "", stderr: "rust-wasi: the working directory /workspace is not beneath a granted --dir\n",
    });
  });

  it("gives each run fresh state from the same compiled program (OBL-FRESH-STATE)", async () => {
    const programs = { "/workspace/tool.wasm": demoBytes };
    expect((await runWasi(["/workspace/tool.wasm", "one"], programs)).stdout).toBe('hello from rust wasm: ["/workspace/tool.wasm", "one"]\n');
    expect((await runWasi(["/workspace/tool.wasm", "two"], programs)).stdout).toBe('hello from rust wasm: ["/workspace/tool.wasm", "two"]\n');
  });
});

describe("runner options", () => {
  it("parses --dir grants and refuses relative or unknown options", () => {
    expect(parseRunnerArguments(["--dir", "/srv:ro", "--dir", "/workspace", "p.wasm", "a"])).toEqual({ kind: "run", program: "p.wasm", args: ["a"], preopens: [{ guest: "/srv", host: "/srv", readOnly: true }, { guest: "/workspace", host: "/workspace", readOnly: false }] });
    expect(parseRunnerArguments(["--", "--help"])).toMatchObject({ kind: "run", program: "--help" });
    expect(parseRunnerArguments(["--dir", "srv"])).toMatchObject({ kind: "usage" });
    expect(parseRunnerArguments(["-q", "p.wasm"])).toEqual({ kind: "usage", message: "unknown option -q" });
    expect(parseRunnerArguments([])).toEqual({ kind: "usage", message: "no program given" });
  });
});
