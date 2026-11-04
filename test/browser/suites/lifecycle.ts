// Signals and durability of Rust programs against the real engine.
import { createVM, defineImage, type UserspaceVM } from "@oxidevm/sdk";
import { enableModuleCommands } from "@oxidevm/sdk/wasm";
import { oxidevmRust } from "./oxidevm.modules.generated";
import { expect, sh, stageFixture, type Config, type Scenario } from "./support";

const isConfig = (value: unknown): value is Config => typeof value === "object" && value !== null && typeof Reflect.get(value, "origin") === "string" && typeof Reflect.get(value, "image") === "object";

const fsops = "rust-wasi /workspace/t/fixture-fsops.wasm";

/** Runs a command on a PTY, sends Ctrl+C after 2 s, and reports how it ended and how fast. */
async function ctrlC(vm: UserspaceVM, command: string, args: readonly string[]): Promise<{ readonly exit: string; readonly ms: number }> {
  const terminal = await vm.spawn({ command, args: [...args], cwd: "/workspace/t", terminal: { columns: 120, rows: 30 }, signal: AbortSignal.timeout(60_000) });
  const reader = terminal.output.getReader();
  const reading = (async () => { for (;;) { const part = await reader.read(); if (part.done) return; } })();
  await new Promise(resolve => setTimeout(resolve, 2000));
  const started = performance.now();
  await terminal.interrupt();
  const exit = await terminal.exit;
  await reading.catch(() => undefined);
  return { exit: exit.kind === "signaled" ? exit.signal ?? `signal ${String(exit.signalNumber)}` : `exit ${String(exit.code)}`, ms: Math.round(performance.now() - started) };
}
export const scenarios: readonly Scenario[] = [
  ["stage fixtures", async vm => { await stageFixture(vm, "fixture-fsops"); await stageFixture(vm, "fixture-binary-echo"); return "staged"; }],
  ["Ctrl+C (SIGINT) ends a sleeping, computing or child-waiting Rust program as a signal death (OBL-SIGNALS)", async vm => {
    const results = [
      await ctrlC(vm, "/usr/local/bin/rust-wasi", ["/workspace/t/fixture-fsops.wasm", "sleep", "600000"]),
      await ctrlC(vm, "/bin/sh", ["-c", "exec /usr/local/bin/rust-wasi /workspace/t/fixture-binary-echo.wasm < /dev/zero > /dev/null"]),
      await ctrlC(vm, "/usr/local/bin/rust-bridge-demo", ["run", "/bin/sleep", "600"]),
    ];
    expect("ctrl-c", results.every(result => result.exit === "SIGINT" && result.ms < 5000), results);
    return results.map(result => `${result.exit} in ${String(result.ms)} ms`).join(", ");
  }],
  ["SIGTERM ends a computing, sleeping or child-waiting Rust program (OBL-SIGNALS)", async vm => {
    // Background jobs of a non-interactive shell start with SIGINT ignored (POSIX), so SIGTERM is sent here.
    const run = await sh(vm, [
      "rust-wasi /workspace/t/fixture-binary-echo.wasm < /dev/zero > /dev/null 2>&1 & m=$!; sleep 1; kill -TERM $m; wait $m; echo compute=$?",
      `${fsops} sleep 600000 > /dev/null & m=$!; sleep 1; kill -TERM $m; wait $m; echo sleep=$?`,
      "rust-bridge-demo run /bin/sleep 600 < /dev/null > /dev/null 2>&1 & m=$!; sleep 1; kill -TERM $m; wait $m; echo child=$?",
    ].join("\n"));
    expect("sigterm", run.stdout === "compute=143\nsleep=143\nchild=143\n", run);
    return run.stdout.trim().replaceAll("\n", ", ");
  }],
  ["a synced, renamed file survives disposing the VM and opening a new one (OBL-DURABLE)", async vm => {
    const config: unknown = Reflect.get(window, "suiteConfig");
    if (!isConfig(config)) throw new Error("the page has no suite config");
    const origin = config.origin, image = defineImage({ mode: "userspace", ...config.image });
    const workspaceId = `rust-durable-${String(Date.now())}`;
    const open = () => createVM({ mode: "userspace", image, memoryMiB: 1024, workspaceId, runtime: { hosting: "self-hosted", baseUrl: `${origin}/engine/` }, network: { mode: "local" } });
    const first = await open();
    let detail = "";
    try {
      await first.exec({ command: "/bin/mkdir", args: ["-p", "/workspace/t"], stdin: new Uint8Array() });
      const fixture = await vm.workspace.read("t/fixture-fsops.wasm");
      await first.workspace.writeFile("t/fixture-fsops.wasm", fixture.data);
      const commands = await enableModuleCommands(first, oxidevmRust);
      try {
        const wrote = await sh(first, `${fsops} sync-write /workspace/t/durable.txt committed-by-rust`);
        expect("write", wrote.stdout === "sync-write: ok synced\n", wrote);
      } finally { await commands.disable(); }
      detail = first.workspace.persistence.kind;
    } finally { await first.dispose(); }
    const second = await open();
    try {
      const read = await sh(second, "cat /workspace/t/durable.txt; ls /workspace/t | grep -c tmp || true");
      expect("after reopen", read.stdout === "committed-by-rust0\n", read);
    } finally { await second.dispose(); }
    return `persistence ${detail}: the file read back by native cat in a new VM; no temporary file left`;
  }],
];
