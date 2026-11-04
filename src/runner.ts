import type { CommandIO } from "@oxidevm/sdk/wasm";
import { admitShape } from "./admission.ts";
import { LIMITS } from "./limits.ts";
import { admit, runProgram, type RustCommandHost } from "./run.ts";
import { AdmissionError } from "./wasi/admission.ts";
import { ROOT_PREOPEN, type Preopen } from "./wasi/preview1.ts";

/** The version `rust-wasi --version` prints (module.ts `version`). */
export const VERSION = "0.0.0";
const USAGE = `usage: rust-wasi [--dir <path>[:ro]]... [--] <program.wasm> [--] [args...]
Runs a wasm32-wasip1 program (a Rust program built with \`cargo build --target wasm32-wasip1\`) as this process.
  --dir <path>      grant only this directory (repeatable; default: the whole VM tree, under your own permissions)
  --dir <path>:ro   grant it read-only
  --                end of options; one -- right after the program is also dropped, so its own arguments follow
`;

export type RunnerArguments =
  | { readonly kind: "help" } | { readonly kind: "version" }
  | { readonly kind: "run"; readonly program: string; readonly args: readonly string[]; readonly preopens: readonly Preopen[] }
  | { readonly kind: "usage"; readonly message: string };

/** Parses rust-wasi's own options; everything after the program belongs to the program, unchanged. */
export function parseRunnerArguments(args: readonly string[]): RunnerArguments {
  const preopens: Preopen[] = [];
  let index = 0;
  for (; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") { index += 1; break; }
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--version") return { kind: "version" };
    if (arg === "--dir") {
      const value = args[index + 1];
      if (value === undefined) return { kind: "usage", message: "--dir needs a directory" };
      const readOnly = value.endsWith(":ro"), path = readOnly ? value.slice(0, -3) : value;
      if (!path.startsWith("/") || path.includes("\0")) return { kind: "usage", message: `--dir needs an absolute directory, not ${JSON.stringify(path)}` };
      preopens.push({ guest: path, host: path, readOnly });
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) return { kind: "usage", message: `unknown option ${arg}` };
    break;
  }
  const program = args[index];
  if (program === undefined) return { kind: "usage", message: "no program given" };
  const rest = args.slice(index + 1);
  return { kind: "run", program, args: rest[0] === "--" ? rest.slice(1) : rest, preopens: preopens.length === 0 ? [ROOT_PREOPEN] : preopens };
}

const O_RDONLY_CLOEXEC = 0o2000000, CHUNK = 64 * 1024;
/** EFBIG, as Linux reports a file larger than a limit. */
class TooLarge extends Error { readonly errno = 27; }

/**
 * Reads the whole program through one descriptor, in chunks, refusing it once it passes LIMITS.programBytes (the SDK's
 * readFile is bounded below that). One open means one file: a rename or rewrite meanwhile cannot mix two programs.
 */
function readProgram(host: RustCommandHost, path: string): Uint8Array {
  const fd = host.fs.open(path, O_RDONLY_CLOEXEC);
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = host.fs.read(fd, CHUNK);
      if (chunk.byteLength === 0) break;
      size += chunk.byteLength;
      if (size > LIMITS.programBytes) throw new TooLarge("program too large");
      chunks.push(chunk);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return bytes;
  } finally { host.fs.close(fd); }
}

const beneath = (path: string, directory: string): boolean => directory === "/" || path === directory || path.startsWith(`${directory.replace(/\/+$/u, "")}/`);

/**
 * `rust-wasi`: reads the program file once (so a concurrent rewrite cannot change what runs), checks its structure,
 * compiles it, checks its imports, and runs it with fresh state. A program that fails any check runs no code.
 */
export function runner(host: RustCommandHost): (io: CommandIO<"rust-bridge-demo" | "rust-wasi">) => Promise<number> {
  return async io => {
    const argv0 = io.invocation.kind === "command" ? io.invocation.argv0 : "rust-wasi";
    const parsed = parseRunnerArguments(io.args);
    switch (parsed.kind) {
      case "help": host.fs.write(io.stdout, new TextEncoder().encode(USAGE)); return 0;
      case "version": host.fs.write(io.stdout, new TextEncoder().encode(`rust-wasi ${VERSION}\n`)); return 0;
      case "usage": return host.fail(2, `${argv0}: ${parsed.message}\n${USAGE.trimEnd()}`);
      case "run": break;
    }
    const cwd = io.cwd;
    if (!parsed.preopens.some(preopen => beneath(cwd, preopen.host))) {
      return host.fail(2, `${argv0}: the working directory ${cwd} is not beneath a granted --dir`);
    }
    let bytes: Uint8Array;
    try { bytes = readProgram(host, parsed.program); }
    catch (error) {
      const errno = error instanceof TooLarge ? error.errno : host.kit.errno.of(error);
      if (errno === undefined) throw error;
      return host.fail(errno === 27 ? 2 : 1, `${argv0}: cannot read ${parsed.program}: ${errno === 27 ? `larger than ${String(LIMITS.programBytes)} bytes` : `Linux errno ${String(errno)}`}`);
    }
    let program: WebAssembly.Module;
    try {
      admitShape(bytes);
      program = await WebAssembly.compile(bytes.slice());
      admit(program);
    } catch (error) {
      if (error instanceof AdmissionError || error instanceof WebAssembly.CompileError) return host.fail(2, `${argv0}: ${parsed.program} ${error instanceof AdmissionError ? error.message : `is not valid WebAssembly: ${error.message}`}`);
      throw error;
    }
    return runProgram(host, program, { argv: [parsed.program, ...parsed.args], env: io.env, cwd, stdio: io, terminals: io.terminals, preopens: parsed.preopens });
  };
}
