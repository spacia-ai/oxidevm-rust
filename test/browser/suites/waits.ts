// SL-05: sleeping on the VM clock without blocking the VM, and a kill during a blocked wait.
import { expect, mainThreadGap, sh, stageFixture, type Scenario } from "./support";

export const scenarios: readonly Scenario[] = [
  ["stage fixtures", async vm => { await stageFixture(vm, "fixture-fsops"); await stageFixture(vm, "fixture-import-probe"); return "staged"; }],
  ["std clock, sleep and HashMap seeding (OBL-CLOCK, OBL-RANDOM)", async vm => {
    const run = await sh(vm, "rust-wasi /workspace/t/fixture-import-probe.wasm time_system time_sleep random_hashmap; date +%s");
    const [system, sleep, random, date] = run.stdout.trim().split("\n");
    const rust = Number(/ok (\d+)s/u.exec(system ?? "")?.[1]), native = Number(date);
    expect("clock", run.status === "exit 0" && Math.abs(rust - native) <= 2 && /time_sleep: ok (5\d|6\d)ms/u.test(sleep ?? "") && random === "random_hashmap: ok 1 entries", run);
    return `Rust time ${String(rust)} vs native ${String(native)}; ${sleep ?? ""}`;
  }],
  ["a 2 s sleep leaves the VM and the page responsive (OBL-POLL)", async vm => {
    const { value, gapMs } = await mainThreadGap(async () => {
      const sleeping = sh(vm, "rust-wasi /workspace/t/fixture-fsops.wasm sleep 2000");
      await new Promise(resolve => setTimeout(resolve, 300));
      const started = performance.now(), other = await sh(vm, "echo other"), otherMs = Math.round(performance.now() - started);
      return { slept: await sleeping, other, otherMs };
    });
    expect("sleep", value.slept.stdout === "sleep: ok slept 2000ms\n" && value.other.stdout === "other\n" && value.otherMs < 1500, value);
    return `slept 2000 ms; another process answered in ${String(value.otherMs)} ms; page max gap ${String(gapMs)} ms`;
  }],
  ["kill -9 during a sleep ends the run; the next command runs (OBL-WAIT-KILL)", async vm => {
    const run = await sh(vm, "rust-wasi /workspace/t/fixture-fsops.wasm sleep 600000 & m=$!; sleep 1; kill -9 $m; wait $m; echo status=$?; rust-wasi /workspace/t/fixture-fsops.wasm cwd");
    expect("kill", run.stdout === "status=137\ncwd: ok /workspace/t\n", run);
    return "137, then the next run works";
  }],
];
