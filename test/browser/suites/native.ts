// SL-06: native Linux children of a Rust program: binary round trip, real pid, exact status, deadlines and ownership.
import { exact, expect, sh, type Scenario } from "./support";

export const scenarios: readonly Scenario[] = [
  ["gzip round trip of every byte value through the bridge (OBL-NATIVE-OUTPUT)", async vm => {
    const run = await sh(vm, "head -c 524288 /dev/urandom > in.bin && rust-bridge-demo run /bin/gzip -c < in.bin > out.gz 2> err.txt; echo status=$?; /bin/gzip -dc out.gz | cmp - in.bin && echo same; grep -c 'Exited(0)' err.txt");
    expect("gzip", run.stdout === "status=0\nsame\n1\n", run);
    return "512 KiB of random bytes compressed by native gzip, decompressed byte-exact";
  }],
  ["the child's parent is the Rust program and it inherits the directory (OBL-NATIVE-CONTEXT)", async vm => {
    const run = await sh(vm, "mkdir -p ctx && cd ctx && rust-bridge-demo run /bin/sh -c 'echo $PPID; pwd' < /dev/null > out.txt 2>/dev/null & m=$!; wait $m; echo module=$m; cat ctx/out.txt 2>/dev/null || cat out.txt");
    const [module, parent, cwd] = run.stdout.trim().split("\n");
    expect("context", module === `module=${parent ?? ""}` && cwd === "/workspace/t/ctx", run);
    return `child's parent ${parent ?? ""} is the module; cwd ${cwd ?? ""}`;
  }],
  ["exit codes and signals stay exact (OBL-CHILD-STATUS)", async vm => exact("status",
    await sh(vm, "for s in 'exit 0' 'exit 119' 'exit 255' 'kill -9 $$'; do rust-bridge-demo run /bin/sh -c \"$s\" < /dev/null 2>&1 | tail -1 | sed 's/child [0-9]*/child N/'; done"),
    { status: 0, stdout: "rust-bridge-demo: child N Exited(0)\nrust-bridge-demo: child N Exited(119)\nrust-bridge-demo: child N Exited(255)\nrust-bridge-demo: child N Signaled(9)\n", stderr: "" })],
  ["validation fails before anything starts; output past its limit is refused (OBL-NATIVE-VALIDATE, OBL-NATIVE-DRAIN)", async vm => exact("validate",
    await sh(vm, "rust-bridge-demo run bin/true < /dev/null; rust-bridge-demo run /nonexistent < /dev/null 2>&1 | head -1; head -c 1048577 /dev/zero > big.bin; rust-bridge-demo run /bin/cat < big.bin > /dev/null 2> big.err; echo cap=$?; cat big.err"),
    { status: 0, stdout: "rust-bridge-demo: the OxideVM host failed with WASI errno 44\ncap=1\nrust-bridge-demo: the native command exceeded its output limit and was killed\n", stderr: "rust-bridge-demo: invalid native command: the program must be an absolute path\n" }).replace("validate", "relative program refused; missing program NOENT; 1 MiB + 1 of output refused")],
  ["SIGKILL of the Rust program kills its owned child (OBL-CHILD-HARD-KILL)", async vm => {
    const run = await sh(vm, "rm -f owned.pid; rust-bridge-demo run /bin/sh -c 'echo $$ > owned.pid; exec sleep 600' < /dev/null & m=$!; while [ ! -s owned.pid ]; do sleep 0.1; done; kill -9 $m; wait $m; echo module=$?; sleep 1; if kill -0 $(cat owned.pid) 2>/dev/null; then echo child=alive; kill -9 $(cat owned.pid); else echo child=gone; fi; ( sleep 600 & echo $! > plain.pid ); sleep 0.2; kill -0 $(cat plain.pid) && echo unowned=alive; kill -9 $(cat plain.pid)");
    expect("owned", run.stdout === "module=137\nchild=gone\nunowned=alive\n", run);
    return "the owned child died with the module; an ordinary orphan was untouched";
  }],
  ["a descendant holding the pipe cannot stall capture past its deadline (OBL-CHILD-DESCENDANT)", async vm => {
    const started = Date.now();
    const run = await sh(vm, "rust-bridge-demo run /bin/sh -c '(sleep 600 &) ; echo direct' < /dev/null; echo status=$?; pkill -f 'sleep 600' || true");
    const ms = Date.now() - started;
    expect("descendant", run.stdout.includes("direct") || run.stderr.includes("deadline"), { run, ms });
    expect("bounded", ms < 60_000, { run, ms });
    return `capture ended after ${String(ms)} ms (deadline 30 s)`;
  }],
];
