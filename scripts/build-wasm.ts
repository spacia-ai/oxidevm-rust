// Builds every Rust fixture for wasm32-wasip1 with the pinned toolchain and stages the pinned demonstration program.
// Source paths are remapped (the workspace to /oxidevm-rust, the toolchain's library sources to /rustc/<commit>), so
// binaries carry no local path or user name; the build fails if one still does.
//
//   node scripts/build-wasm.ts
import { execFileSync } from "node:child_process";
import { copyFile, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const run = (command: string, args: readonly string[]): string => execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
const sysroot = run("rustc", ["--print", "sysroot"]);
const commit = /commit-hash: ([0-9a-f]{40})/u.exec(run("rustc", ["-vV"]))?.[1];
if (commit === undefined) throw new Error("rustc -vV reported no commit hash");
const flags = [
  "-C", "link-arg=--max-memory=268435456", "-C", "link-arg=-zstack-size=1048576",
  `--remap-path-prefix=${root}=/oxidevm-rust`,
  `--remap-path-prefix=${join(sysroot, "lib/rustlib/src/rust")}=/rustc/${commit}`,
  `--remap-path-prefix=${join(homedir(), ".cargo")}=/cargo`,
];
execFileSync("cargo", ["build", "--locked", "--release", "--target", "wasm32-wasip1"], {
  cwd: root, stdio: "inherit", env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join("\x1f") },
});
const built = join(root, "target/wasm32-wasip1/release");
const leaks = [homedir(), root, "/home/"];
for (const file of (await readdir(built)).filter(name => name.endsWith(".wasm"))) {
  const bytes = await readFile(join(built, file));
  const found = leaks.find(needle => bytes.includes(needle, 0, "utf8"));
  if (found !== undefined) throw new Error(`${file} still contains the local path ${found}`);
}
await copyFile(join(built, "bridge-demo.wasm"), join(root, "upstream/bridge-demo.wasm"));
process.stdout.write("built and staged upstream/bridge-demo.wasm\n");
