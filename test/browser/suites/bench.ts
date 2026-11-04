// SL-10 diagnostic benchmark: the same compute workload and output as the native and direct-WebAssembly runs. Wall time
// is measured on the page around each /bin/sh run, so it includes the shell, the module process and the run's start-up.
import { expect, sh, stageFixture, type Scenario } from "./support";

const ROUNDS = 40, CHECKSUM = "checksum 0a4417c859dfcaf5 rounds 40\n";
export const scenarios: readonly Scenario[] = [
  ["stage", async vm => { await stageFixture(vm, "fixture-bench"); return "staged"; }],
  ["compute in the VM via rust-wasi: one warm-up, five samples (OBL-BENCH, diagnostic)", async vm => {
    const samples: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const started = performance.now();
      const run = await sh(vm, `rust-wasi /workspace/t/fixture-bench.wasm ${String(ROUNDS)}`);
      const ms = Math.round(performance.now() - started);
      expect("checksum", run.stdout === CHECKSUM, run);
      if (index > 0) samples.push(ms);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const trivial: number[] = [];
    for (let index = 0; index < 6; index += 1) {
      const started = performance.now();
      await sh(vm, "rust-wasi /workspace/t/fixture-bench.wasm 0");
      if (index > 0) trivial.push(Math.round(performance.now() - started));
    }
    return `samples ${samples.join(", ")} ms; median ${String(sorted[2])} ms; max ${String(sorted[4])} ms; empty run (rounds 0) median ${String([...trivial].sort((a, b) => a - b)[2])} ms`;
  }],
];
