// Release checks (SL-11) before any tag: two clean builds of every Rust artifact must be byte-identical, the module
// release may contain only its own files, and no file may carry a local path, a user name or planning material.
//
//   node scripts/release-check.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const run = (command: string, args: readonly string[]): string => execFileSync(command, args, { cwd: root, stdio: ["ignore", "pipe", "inherit"], encoding: "utf8" });
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
async function hashes(directory: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of (await readdir(directory)).filter(file => file.endsWith(".wasm")).sort()) out.set(name, sha256(await readFile(join(directory, name))));
  return out;
}
const failures: string[] = [];

// 1. Reproducibility: build twice from a clean target directory and compare every artifact.
const built = join(root, "target/wasm32-wasip1/release");
const builds: Map<string, string>[] = [];
for (let pass = 0; pass < 2; pass += 1) {
  await rm(join(root, "target/wasm32-wasip1"), { recursive: true, force: true });
  run(process.execPath, ["scripts/build-wasm.ts"]);
  builds.push(await hashes(built));
}
const [first = new Map<string, string>(), second = new Map<string, string>()] = builds;
for (const [name, hash] of first) if (second.get(name) !== hash) failures.push(`${name} differs between two clean builds`);

// 2. The pinned artifact in upstream/ is exactly what the build produces.
if (sha256(await readFile(join(root, "upstream/bridge-demo.wasm"))) !== first.get("bridge-demo.wasm")) failures.push("upstream/bridge-demo.wasm is not the reproducible build output");

// 3. The module release contains only its own files, and nothing local or private.
run(process.execPath, [join(root, "node_modules/@oxidevm/cli/dist/bin.js"), "wasm", "build", "--project", root]);
const allowed = new Set(["module.json", "adapter.mjs", "bridge-demo.wasm", "LICENSE", "NOTICE", "SHA256SUMS"]);
const release = (await readdir(join(root, "dist"))).sort();
for (const name of release) if (!allowed.has(name)) failures.push(`dist/${name} is not part of the release`);
const forbidden = [homedir(), root, "/home/", "implementation-path", ".oxidevm/plans", "Co-Authored-By"];
for (const name of release) {
  const bytes = await readFile(join(root, "dist", name));
  for (const needle of forbidden) if (bytes.includes(needle)) failures.push(`dist/${name} contains ${JSON.stringify(needle)}`);
}

// 4. Local design material and plans are never tracked.
const tracked = run("git", ["ls-files"]).split("\n").filter(Boolean);
for (const path of tracked) if (path.startsWith("docs/") || /implementation-path|\.oxidevm\/plans/u.test(path)) failures.push(`${path} is tracked but must stay local`);

process.stdout.write(`${JSON.stringify({ reproducible: [...first].map(([name, hash]) => `${name} ${hash.slice(0, 16)}`), release, failures }, null, 2)}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
