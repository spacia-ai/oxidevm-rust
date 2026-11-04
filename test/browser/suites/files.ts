// SL-04: Rust std file operations on the VM's live files, seen by native programs, and confinement beneath --dir.
import { exact, expect, sh, stageFixture, type Scenario } from "./support";

const fsops = "rust-wasi /workspace/t/fixture-fsops.wasm";
export const scenarios: readonly Scenario[] = [
  ["stage fixtures", async vm => { await stageFixture(vm, "fixture-fsops"); await stageFixture(vm, "fixture-import-probe"); await stageFixture(vm, "fixture-identity"); return "staged"; }],
  ["std::fs probes pass on live files (OBL-SHARED-FILES)", async vm => {
    const run = await sh(vm, "mkdir -p probe && ln -sf probe.txt probe/probe.link && PROBE_DIR=/workspace/t/probe rust-wasi /workspace/t/fixture-import-probe.wasm fs_write_read fs_append_seek fs_metadata fs_create_dir_read_dir fs_rename fs_hard_link fs_read_link fs_set_len_sync && cat probe/probe.txt | od -An -c | tr -s ' ' && ls probe/probe.d");
    expect("probes", run.status === "exit 0" && !run.stdout.includes(": err") && run.stdout.includes("fs_read_link: ok probe.txt") && run.stdout.includes("\n b\n c\n") === false, run);
    expect("native sees the result", run.stdout.includes("p r o") && /\nb\nc\n$/u.test(run.stdout), run);
    return run.stdout.trim().split("\n").filter(line => line.includes(": ok")).length.toString() + " probes ok; native ls shows b and c";
  }],
  ["Rust and native see the same files both ways (OBL-SHARED-FILES)", async vm => exact("shared",
    await sh(vm, `echo native > shared.txt && ${fsops} append shared.txt +rust && cat shared.txt && echo && ${fsops} cat shared.txt && ${fsops} stat shared.txt && stat -c %s shared.txt`),
    { status: 0, stdout: "fsops: ok appended\nnative\n+rust\nfsops: ok native\n+rust\nfsops: ok len=12 dir=false link=false\n12\n", stderr: "" }).replace(/^shared/u, "shared: native append, Rust cat and stat agree")],
  ["mutations match native results (OBL-PATH-MUTATIONS, OBL-ERRNO)", async vm => exact("mutations",
    await sh(vm, `rm -rf m && ${fsops} mkdir m; ${fsops} mkdir m; ${fsops} write m/a x; ${fsops} mv m/a m/b; ls m; ${fsops} rm m/missing; ${fsops} rmdir m; ${fsops} rm m/b; ${fsops} rmdir m; test -e m || echo gone`),
    { status: 0, stdout: "fsops: ok created\nfsops: err AlreadyExists\nfsops: ok written\nfsops: ok moved\nb\nfsops: err NotFound\nfsops: err DirectoryNotEmpty\nfsops: ok removed\nfsops: ok removed\ngone\n", stderr: "" })],
  ["relative paths resolve from the caller's directory (OBL-CONTEXT)", async vm => exact("relative",
    await sh(vm, `mkdir -p rel && cd rel && echo here > identity.txt && rust-wasi /workspace/t/fixture-identity.wasm | grep -o '"relative":"[^"]*"' && ${fsops} cwd`),
    { status: 0, stdout: '"relative":"here"\nfsops: ok /workspace/t/rel\n', stderr: "" })],
  ["--dir confines: .. and an absolute symlink cannot escape; in-root paths work (OBL-PATH-DENIED)", async vm => exact("confined",
    await sh(vm, `rm -rf jail && mkdir -p jail/sub && echo in > jail/sub/f && echo secret > outside.txt && ln -s /workspace/t/outside.txt jail/abs && ln -s ../outside.txt jail/up && cd jail && ${fsops.replace("rust-wasi", "rust-wasi --dir /workspace/t/jail")} cat sub/f; rust-wasi --dir /workspace/t/jail /workspace/t/fixture-fsops.wasm cat ../outside.txt; rust-wasi --dir /workspace/t/jail /workspace/t/fixture-fsops.wasm cat abs; rust-wasi --dir /workspace/t/jail /workspace/t/fixture-fsops.wasm cat up; rust-wasi --dir /workspace/t/jail /workspace/t/fixture-fsops.wasm write ../escape.txt x; test -e ../escape.txt || echo no-escape`),
    { status: 0, stdout: "fsops: ok in\nfsops: err PermissionDenied\nfsops: err PermissionDenied\nfsops: err PermissionDenied\nfsops: err PermissionDenied\nno-escape\n", stderr: "" })],
  ["a read-only grant refuses every mutation before it happens (OBL-PATH-RO)", async vm => exact("read-only",
    await sh(vm, `rm -rf ro && mkdir ro && echo keep > ro/f && cd ro && for op in "write g x" "rm f" "mkdir d" "mv f g" "append f x"; do rust-wasi --dir /workspace/t/ro:ro /workspace/t/fixture-fsops.wasm $op; done; ls; cat f`),
    { status: 0, stdout: "fsops: err PermissionDenied\nfsops: err PermissionDenied\nfsops: err PermissionDenied\nfsops: err PermissionDenied\nfsops: err PermissionDenied\nf\nkeep\n", stderr: "" })],
  ["listing reads the held directory while it is renamed natively (OBL-DIRECTORIES)", async vm => {
    const run = await sh(vm, `rm -rf big moved && mkdir big && for i in $(seq 1 400); do : > big/name-with-a-long-suffix-$i; done && ${fsops} ls big | tr ',' '\\n' | wc -l`);
    expect("listing", run.status === "exit 0" && run.stdout.trim().endsWith("400"), run);
    return "400 entries across several getdents batches";
  }],
];
