// Runs cargo for this workspace. oxidevm-bridge comes from crates.io; to try an unreleased change, OXIDEVM_BRIDGE_PATH names a checkout
// of it (<oxidevm-sdk>/crates/oxidevm-bridge) and this wrapper patches it in for every cargo command. The --config
// goes after the subcommand so cargo-clippy and other external subcommands pass it on to the cargo they run.
//
//   OXIDEVM_BRIDGE_PATH=../oxidevm-sdk/crates/oxidevm-bridge node scripts/cargo.ts clippy --workspace -- -D warnings
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export function bridgePatch(): readonly string[] {
  const path = process.env["OXIDEVM_BRIDGE_PATH"];
  return path === undefined || path === "" ? [] : ["--config", `patch.crates-io.oxidevm-bridge.path=${JSON.stringify(resolve(path))}`];
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command === undefined) { process.stderr.write("usage: node scripts/cargo.ts <cargo command> [args...]\n"); process.exit(2); }
  const result = spawnSync("cargo", [command, ...(command === "fmt" ? [] : bridgePatch()), ...rest], { stdio: "inherit", cwd: resolve(import.meta.dirname, "..") });
  process.exitCode = result.status ?? 1;
}
