// SL-10: five runs of the pinned program reuse the verified, compiled artifact; each run has fresh state.
import { expect, sh, type Scenario } from "./support";

export const scenarios: readonly Scenario[] = [
  ["five runs, one artifact fetch, fresh state each time (OBL-CACHE)", async vm => {
    const started = performance.now();
    const run = await sh(vm, "for i in 1 2 3 4 5; do rust-bridge-demo run-$i; done");
    const ms = Math.round(performance.now() - started);
    expect("runs", run.stdout === [1, 2, 3, 4, 5].map(i => `hello from rust wasm: ["rust-bridge-demo", "run-${String(i)}"]\n`).join(""), run);
    return `5 runs in ${String(ms)} ms (${String(Math.round(ms / 5))} ms each, diagnostic); fetch count in the driver's report`;
  }],
];
