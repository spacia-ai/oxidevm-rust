import type { CommandIO, Preopen } from "@oxidevm/sdk/wasm";
import type { RustHost } from "./command.ts";

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
  | { readonly kind: "run"; readonly program: string; readonly args: readonly string[]; readonly preopens: readonly Preopen[] | undefined }
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
  // No --dir: the kit's default grant, the whole tree under the caller's own credentials.
  return { kind: "run", program, args: rest[0] === "--" ? rest.slice(1) : rest, preopens: preopens.length === 0 ? undefined : preopens };
}

const beneath = (path: string, directory: string): boolean => directory === "/" || path === directory || path.startsWith(`${directory.replace(/\/+$/u, "")}/`);

/**
 * `rust-wasi`: reads the program file once (so a concurrent rewrite cannot change what runs), checks its structure,
 * compiles it, checks its imports, and runs it with fresh state. A program that fails any check runs no code.
 */
export function runner(host: RustHost): (io: CommandIO<"rust-bridge-demo" | "rust-wasi">) => Promise<number> {
  const wasi = host.kit.wasi;
  return async io => {
    const argv0 = io.invocation.kind === "command" ? io.invocation.argv0 : "rust-wasi";
    const parsed = parseRunnerArguments(io.args);
    switch (parsed.kind) {
      case "help": host.fs.write(io.stdout, new TextEncoder().encode(USAGE)); return 0;
      case "version": host.fs.write(io.stdout, new TextEncoder().encode(`rust-wasi ${VERSION}\n`)); return 0;
      case "usage": return host.fail(2, `${argv0}: ${parsed.message}\n${USAGE.trimEnd()}`);
      case "run": break;
    }
    if (parsed.preopens !== undefined && !parsed.preopens.some(preopen => beneath(io.cwd, preopen.host))) {
      return host.fail(2, `${argv0}: the working directory ${io.cwd} is not beneath a granted --dir`);
    }
    let bytes: Uint8Array;
    try { bytes = wasi.readProgram(host, parsed.program); }
    catch (error) {
      const errno = typeof error === "object" && error !== null && typeof Reflect.get(error, "errno") === "number" ? Number(Reflect.get(error, "errno")) : undefined;
      if (errno === undefined) throw error;
      return host.fail(errno === 27 ? 2 : 1, `${argv0}: cannot read ${parsed.program}: ${errno === 27 ? `larger than ${String(wasi.limits.programBytes)} bytes` : `Linux errno ${String(errno)}`}`);
    }
    let program: WebAssembly.Module;
    try { program = await wasi.compile(bytes); }
    catch (error) {
      if (error instanceof wasi.AdmissionError || error instanceof WebAssembly.CompileError) return host.fail(2, `${argv0}: ${parsed.program} ${error instanceof wasi.AdmissionError ? error.message : `is not valid WebAssembly: ${error.message}`}`);
      throw error;
    }
    return wasi.run(host, program, io, { argv: [parsed.program, ...parsed.args], ...(parsed.preopens === undefined ? {} : { preopens: parsed.preopens }) });
  };
}
