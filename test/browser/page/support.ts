// Shared by every suite: the VM, /bin/sh runs with exact results, and the page's main-thread responsiveness.
import { createVM, defineImage } from "@oxidevm/sdk";
import type { UserspaceVM } from "@oxidevm/sdk";

export interface Config {
  readonly origin: string;
  readonly image: { readonly manifestUrl: string; readonly manifestSHA256: string; readonly trust: { readonly algorithm: "Ed25519"; readonly keyId: string; readonly publicKey: string } };
}
export interface Result { readonly name: string; readonly ok: boolean; readonly detail: string }
export type Scenario = readonly [name: string, run: (vm: UserspaceVM) => Promise<string>];

export const encoder = new TextEncoder(), decoder = new TextDecoder();

export function openVM(config: Config): Promise<UserspaceVM> {
  const image = defineImage({ mode: "userspace", ...config.image });
  return createVM({ mode: "userspace", image, memoryMiB: 1536, runtime: { hosting: "self-hosted", baseUrl: `${config.origin}/engine/` }, network: { mode: "local" } });
}

export async function runAll(vm: UserspaceVM, scenarios: readonly Scenario[]): Promise<readonly Result[]> {
  const results: Result[] = [];
  for (const [name, run] of scenarios) {
    console.info(`scenario: ${name}`);
    try { results.push({ name, ok: true, detail: await run(vm) }); }
    catch (error: unknown) { results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  }
  return results;
}

export interface ShellRun { readonly status: string; readonly stdout: string; readonly stderr: string }
/** One `/bin/sh -c` run in /workspace/t, with how it ended and everything it wrote. */
export async function sh(vm: UserspaceVM, script: string, timeoutMs = 300_000): Promise<ShellRun> {
  const result = await vm.exec({ command: "/bin/sh", args: ["-c", script], cwd: "/workspace/t", stdin: encoder.encode(""), signal: AbortSignal.timeout(timeoutMs) });
  return { status: result.exit.kind === "exited" ? `exit ${String(result.exit.code)}` : `signal ${String(result.exit.signalNumber)}`, stdout: decoder.decode(result.stdout), stderr: decoder.decode(result.stderr) };
}
/** Throws with the whole run when `condition` is false. */
export function expect(label: string, condition: boolean, evidence: unknown): void {
  if (!condition) throw new Error(`${label}: ${JSON.stringify(evidence)}`);
}
/** Compares a run with exactly the status, stdout and stderr it must have. */
export function exact(label: string, run: ShellRun, want: { readonly status: number; readonly stdout: string; readonly stderr: string }): string {
  expect(label, run.status === `exit ${String(want.status)}` && run.stdout === want.stdout && run.stderr === want.stderr, { want, run });
  return `${label}: ${run.status}`;
}
/** The largest gap between 10 ms page ticks while `work` runs. */
export async function mainThreadGap<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly gapMs: number }> {
  let last = performance.now(), gap = 0;
  const timer = setInterval(() => { const now = performance.now(); gap = Math.max(gap, now - last); last = now; }, 10);
  try { return { value: await work(), gapMs: Math.round(gap) }; } finally { clearInterval(timer); }
}

/** Copies a Rust fixture served beside the page into the VM at /workspace/t/<name>.wasm. */
export async function stageFixture(vm: UserspaceVM, name: string): Promise<string> {
  const response = await fetch(new URL(`fixtures/${name}.wasm`, document.baseURI));
  if (!response.ok) throw new Error(`fixture ${name} is missing`);
  const path = `t/${name}.wasm`;
  await vm.workspace.writeFile(path, new Uint8Array(await response.arrayBuffer()));
  return `/workspace/${path}`;
}
