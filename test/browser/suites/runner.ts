// SL-08: rust-wasi on guest-supplied files: admission before any code runs, fresh state, concurrency and kills.
import { exact, expect, sh, stageFixture, type Scenario } from "./support";

export const scenarios: readonly Scenario[] = [
  ["stage fixtures", async vm => { await stageFixture(vm, "fixture-fsops"); await stageFixture(vm, "fixture-binary-echo"); return "staged"; }],
  ["a local program runs with its own arguments; bad files never start (OBL-RUNNER)", async vm => exact("runner",
    await sh(vm, "printf 'junk' > junk.wasm; rust-wasi /workspace/t/fixture-fsops.wasm -- cwd; rust-wasi missing.wasm; echo s=$?; rust-wasi junk.wasm; echo s=$?"),
    { status: 0, stdout: "fsops: ok /workspace/t\ns=1\ns=2\n", stderr: "rust-wasi: cannot read missing.wasm: Linux errno 2\nrust-wasi: junk.wasm is not a WebAssembly binary\n" })],
  ["concurrent runs of one program keep separate state (OBL-FRESH-STATE)", async vm => {
    const run = await sh(vm, "for i in 1 2 3 4; do (printf \"run-$i\" | rust-wasi /workspace/t/fixture-binary-echo.wasm > out-$i.txt 2>/dev/null) & done; wait; cat out-1.txt out-2.txt out-3.txt out-4.txt");
    expect("concurrent", run.stdout === "run-1run-2run-3run-4", run);
    return "four concurrent runs, four separate outputs";
  }],
  ["a runaway program is killable; the VM stays usable (OBL-RESOURCE-KILL)", async vm => {
    const run = await sh(vm, "rust-wasi /workspace/t/fixture-binary-echo.wasm < /dev/zero > /dev/null & m=$!; sleep 2; kill -9 $m; wait $m; echo status=$?; echo alive");
    expect("kill", run.stdout === "status=137\nalive\n", run);
    return "137 after kill -9; next command ran";
  }],
];
