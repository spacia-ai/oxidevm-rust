// SL-02: process identity, launch context and standard streams of the pinned Rust program, run by /bin/sh in the VM.
import type { UserspaceVM } from "@oxidevm/sdk";
import { decoder, exact, expect, mainThreadGap, sh, type Scenario } from "./support";

async function terminalRun(vm: UserspaceVM, script: string): Promise<string> {
  const terminal = await vm.spawn({ command: "/bin/sh", args: ["-c", script], cwd: "/workspace/t", terminal: { columns: 120, rows: 30 }, signal: AbortSignal.timeout(120_000) });
  const reader = terminal.output.getReader();
  let screen = "";
  const reading = (async () => { for (;;) { const part = await reader.read(); if (part.done) return; screen += decoder.decode(part.value, { stream: true }); } })();
  await terminal.exit;
  await reading.catch(() => undefined);
  return screen;
}

export const scenarios: readonly Scenario[] = [
  ["identity: the VM's pid, parent and credentials (OBL-PID)", async vm => {
    const run = await sh(vm, "rust-bridge-demo identity < /dev/null > id.json & m=$!; wait $m; echo \"status=$? module=$m shell=$$ uid=$(id -u) gid=$(id -g)\"; cat id.json");
    const [line, json] = run.stdout.split("\n");
    const ids = /^status=0 module=(\d+) shell=(\d+) uid=(\d+) gid=(\d+)$/u.exec(line ?? "");
    expect("shell ids", ids !== null, run);
    const seen: unknown = JSON.parse(json ?? "null");
    const want = { pid: Number(ids?.[1]), parent: Number(ids?.[2]), uid: Number(ids?.[3]), gid: Number(ids?.[4]) };
    expect("identity", typeof seen === "object" && seen !== null && Object.entries(want).every(([key, value]) => Reflect.get(seen, key) === value), { want, seen });
    return `pid ${String(want.pid)} parent ${String(want.parent)} uid ${String(want.uid)} gid ${String(want.gid)}`;
  }],
  ["working directory restored for std (OBL-CONTEXT)", async vm => {
    const run = await sh(vm, "mkdir -p sub/inner && cd sub/inner && rust-bridge-demo identity < /dev/null");
    expect("directory", run.status === "exit 0" && run.stdout.includes('"bridgeCwd":"/workspace/t/sub/inner","stdCwd":"/workspace/t/sub/inner"'), run);
    return "bridge and std both report /workspace/t/sub/inner";
  }],
  ["argv exactly, argv0 as typed (OBL-ARGS)", async vm => exact("argv",
    await sh(vm, "rust-bridge-demo '' --x 'two words' zażółć; /usr/local/bin/rust-bridge-demo alias"),
    { status: 0, stdout: 'hello from rust wasm: ["rust-bridge-demo", "", "--x", "two words", "zażółć"]\nhello from rust wasm: ["/usr/local/bin/rust-bridge-demo", "alias"]\n', stderr: "" })],
  ["1 MiB binary through file, pipe and NUL bytes (OBL-BINARY-IO)", async vm => {
    const { value: run, gapMs } = await mainThreadGap(() => sh(vm, [
      "head -c 1048576 /dev/urandom > in.bin && printf '\\000\\377\\000' >> in.bin",
      "rust-bridge-demo echo < in.bin > out.bin 2> err.txt; echo file=$?; cmp in.bin out.bin && echo file-same; cat err.txt",
      "cat in.bin | rust-bridge-demo echo 2>/dev/null | sha256sum | cut -c1-64 > piped.sum; sha256sum in.bin | cut -c1-64 > in.sum; cmp piped.sum in.sum && echo pipe-same",
    ].join("\n")));
    expect("binary", run.stdout === "file=0\nfile-same\nrust-bridge-demo: 1048579 bytes\npipe-same\n", run);
    return `file and pipe byte-exact (1048579 bytes); page max gap ${String(gapMs)} ms`;
  }],
  ["backpressure from a slow reader (OBL-PARTIAL-IO)", async vm => {
    const run = await sh(vm, "head -c 3000000 /dev/urandom > big.bin; rust-bridge-demo echo < big.bin 2>/dev/null | (sleep 2; cat) | sha256sum | cut -c1-64 > slow.sum; sha256sum big.bin | cut -c1-64 | cmp - slow.sum && echo slow-same");
    expect("slow reader", run.stdout === "slow-same\n", run);
    return "3 MB through a reader that starts 2 s late, byte-exact";
  }],
  ["broken pipe: default SIGPIPE kills, ignored SIGPIPE is EPIPE (OBL-PARTIAL-IO)", async vm => {
    const run = await sh(vm, [
      "head -c 3000000 /dev/zero > zero.bin",
      "( rust-bridge-demo echo < zero.bin 2>/dev/null; echo default=$? >&2 ) | head -c 10 > /dev/null",
      "( trap '' PIPE; rust-bridge-demo echo < zero.bin 2> ignored.err; echo ignored=$? >&2 ) | head -c 10 > /dev/null",
      "cat ignored.err >&2",
    ].join("\n"));
    expect("sigpipe", run.stderr.includes("default=141") && run.stderr.includes("ignored=1") && run.stderr.includes("Broken pipe"), run);
    return run.stderr.trim().replaceAll("\n", "; ");
  }],
  ["terminal vs redirected streams (OBL-TTY)", async vm => {
    const screen = await terminalRun(vm, "rust-bridge-demo identity --prompt; rust-bridge-demo identity --prompt < /dev/null > tty-redirected.json 2>&1; echo done");
    const redirected = await sh(vm, "cat tty-redirected.json");
    expect("terminal", screen.includes('"terminals":[true,true,true]') && screen.includes("prompt> "), screen);
    expect("redirected", redirected.stdout.includes('"terminals":[false,false,false]') && !redirected.stdout.includes("prompt>"), redirected);
    return "a PTY reads as a terminal with a prompt; a redirected run has no prompt";
  }],
  ["exit status 0-119 exact, larger reported (OBL-EXIT)", async vm => exact("exit",
    await sh(vm, "rust-bridge-demo --exit 7 > /dev/null; echo a=$?; rust-bridge-demo --exit 119 > /dev/null; echo b=$?; rust-bridge-demo --exit 200 > /dev/null; echo c=$?"),
    { status: 0, stdout: "a=7\nb=119\nc=1\n", stderr: "rust-bridge-demo: the program exited with status 200, which a module command cannot report exactly (0-119); reporting 1\n" })],
];
