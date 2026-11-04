// Import census for the Rust fixtures (SL-01, OBL-CONTRACT): for each built .wasm it records every import, the exports,
// the defined memory and table limits and whether a start section exists, and compares the WASI imports with the
// Preview1 disposition table in docs/wasi-preview1-imports.json. Exits 1 when a fixture imports a name the table does
// not classify, or when its memory or table shape falls outside the frozen profile.
//
//   cargo build --locked --release --target wasm32-wasip1 && node scripts/inspect-fixtures.ts [--json]
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const built = join(root, "target/wasm32-wasip1/release");

interface Limits { readonly min: number; readonly max: number | null; readonly shared: boolean; readonly memory64: boolean }
interface Table { readonly element: number; readonly limits: Limits }
interface Shape { readonly memories: readonly Limits[]; readonly tables: readonly Table[]; readonly start: boolean }

/** Reads the LEB128 unsigned integer at `offset`; returns the value and the next offset. */
function leb(bytes: Uint8Array, offset: number): [number, number] {
  let value = 0, shift = 0, at = offset;
  for (;;) {
    const byte = bytes[at];
    if (byte === undefined || shift > 35) throw new Error("truncated LEB128");
    value += (byte & 0x7f) * 2 ** shift; at += 1; shift += 7;
    if ((byte & 0x80) === 0) return [value, at];
  }
}
function limits(bytes: Uint8Array, offset: number): [Limits, number] {
  const flags = bytes[offset];
  if (flags === undefined) throw new Error("truncated limits");
  const [min, afterMin] = leb(bytes, offset + 1);
  let at = afterMin, max: number | null = null;
  if ((flags & 1) !== 0) [max, at] = leb(bytes, afterMin);
  return [{ min, max, shared: (flags & 2) !== 0, memory64: (flags & 4) !== 0 }, at];
}
/** Defined memories, tables and the start section; imported ones appear in `WebAssembly.Module.imports`. */
function shape(bytes: Uint8Array): Shape {
  const memories: Limits[] = [], tables: Table[] = [];
  let start = false, at = 8;
  while (at < bytes.length) {
    const id = bytes[at];
    const [size, body] = leb(bytes, at + 1);
    if (id === 4 || id === 5) {
      let [count, cursor] = leb(bytes, body);
      for (; count > 0; count -= 1) {
        if (id === 4) {
          const element = bytes[cursor] ?? -1;
          const [table, next] = limits(bytes, cursor + 1); tables.push({ element, limits: table }); cursor = next;
        } else { const [memory, next] = limits(bytes, cursor); memories.push(memory); cursor = next; }
      }
    }
    if (id === 8) start = true;
    at = body + size;
  }
  return { memories, tables, start };
}

const table: unknown = JSON.parse(await readFile(join(root, "docs/wasi-preview1-imports.json"), "utf8"));
const listed: unknown = typeof table === "object" && table !== null ? Reflect.get(table, "imports") : undefined;
if (!Array.isArray(listed)) throw new Error("docs/wasi-preview1-imports.json has no imports list");
const known = new Map<string, string>();
for (const entry of listed as readonly unknown[]) {
  if (typeof entry !== "object" || entry === null) throw new Error("an import entry must be an object");
  const name: unknown = Reflect.get(entry, "name"), disposition: unknown = Reflect.get(entry, "disposition");
  if (typeof name !== "string" || typeof disposition !== "string") throw new Error("an import entry needs a name and a disposition");
  known.set(name, disposition);
}
if (known.size !== 46) throw new Error(`docs/wasi-preview1-imports.json classifies ${String(known.size)} imports, not 46`);

interface Entry extends Shape {
  readonly bytes: number;
  readonly imports: readonly string[];
  readonly dispositions: Readonly<Record<string, string>>;
  readonly exports: readonly string[];
  readonly problems: readonly string[];
}
const report: Record<string, Entry> = {};
let failures = 0;
for (const file of (await readdir(built)).filter(name => name.endsWith(".wasm")).sort()) {
  const bytes = new Uint8Array(await readFile(join(built, file)));
  const module = new WebAssembly.Module(bytes);
  const imports = WebAssembly.Module.imports(module), exports = WebAssembly.Module.exports(module);
  const defined = shape(bytes), problems: string[] = [];
  for (const entry of imports) {
    if (entry.kind !== "function") problems.push(`imports a ${entry.kind} ${entry.module}.${entry.name}`);
    else if (entry.module === "wasi_snapshot_preview1" && !known.has(entry.name)) problems.push(`unclassified WASI import ${entry.name}`);
    else if (entry.module !== "wasi_snapshot_preview1" && !/^oxidevm_bridge_(?:v1|spike)$/u.test(entry.module)) problems.push(`unknown import namespace ${entry.module}`);
  }
  if (defined.memories.length !== 1) problems.push(`${String(defined.memories.length)} memories`);
  for (const memory of defined.memories) if (memory.max === null || memory.max > 4096 || memory.shared || memory.memory64) problems.push(`memory ${JSON.stringify(memory)}`);
  if (defined.tables.length > 1) problems.push(`${String(defined.tables.length)} tables`);
  for (const { element, limits: bound } of defined.tables) if (element !== 0x70 || bound.max === null || bound.max > 65536) problems.push(`table ${JSON.stringify({ element, ...bound })}`);
  if (defined.start) problems.push("start section");
  failures += problems.length;
  report[file] = {
    bytes: bytes.length,
    imports: imports.map(entry => `${entry.module}.${entry.name}`),
    dispositions: Object.fromEntries(imports.filter(entry => entry.module === "wasi_snapshot_preview1").map(entry => [entry.name, known.get(entry.name) ?? "unclassified"])),
    exports: exports.map(entry => `${entry.kind}:${entry.name}`),
    ...defined, problems,
  };
}
if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
else for (const [file, { imports, problems, memories, tables }] of Object.entries(report)) {
  process.stdout.write(`${file}: ${String(imports.length)} imports, memory ${JSON.stringify(memories)}, tables ${JSON.stringify(tables)}${problems.length === 0 ? "" : `\n  PROBLEMS: ${problems.join("; ")}`}\n  ${imports.join(" ")}\n`);
}
process.exitCode = failures === 0 ? 0 : 1;
