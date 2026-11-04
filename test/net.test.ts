import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { NetError, type CommandIO, type NetSyncConnection as SyncConnection, type WasiRunHost } from "@oxidevm/sdk/wasm";
import { rustCommand, type RustCommandName } from "../src/command.ts";
import { descriptor, streams } from "./support/streams.ts";

type NetSyncHost = NonNullable<WasiRunHost["net"]>;

const demo = new WebAssembly.Module(await readFile(new URL("../upstream/bridge-demo.wasm", import.meta.url)));
const io = (args: readonly string[]): CommandIO<RustCommandName> => ({ args, env: {}, cwd: "/workspace", stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), invocation: { kind: "host" }, terminals: { stdin: false, stdout: false, stderr: false } });

/** An echo peer: answers everything it received, upper-cased, once this side half-closes. */
function echoNetwork(log: string[]): NetSyncHost {
  const peer = (): SyncConnection => {
    const received: number[] = []; let closedWrite = false, answered = false;
    return {
      write: bytes => { if (closedWrite) throw new NetError("EPIPE", "closed", { errno: 32 }); received.push(...bytes); },
      closeWrite: () => { closedWrite = true; log.push("closeWrite"); },
      read: () => { if (!closedWrite || answered) return new Uint8Array(); answered = true; return Uint8Array.from(received.map(byte => byte >= 97 && byte <= 122 ? byte - 32 : byte)); },
      close: () => { log.push("close"); },
      alpn: null,
    };
  };
  return {
    connectSync: options => { log.push(`tcp ${options.host}:${String(options.port)}${options.tls === true ? " tls" : ""}`); return peer(); },
    connectUnixSync: path => {
      if (path === "/run/missing.sock") throw new NetError("ENOENT", "no such socket", { errno: 2 });
      if (path === "/run/refused.sock") throw new NetError("ECONNREFUSED", "refused", { errno: 111 });
      log.push(`unix ${path}`); return peer();
    },
  };
}
async function run(args: readonly string[], netSync: NetSyncHost | undefined, stdin = "") {
  const fake = streams({ stdin: new TextEncoder().encode(stdin), ...(netSync === undefined ? {} : { net: netSync }) });
  const status = await rustCommand(fake.host, demo).main(io(args));
  return { status, stdout: new TextDecoder().decode(fake.stdout()), stderr: fake.stderr() };
}

describe("VM sockets through the bridge (OBL-TCP, OBL-UNIX; unit level)", () => {
  it("exchanges bytes over TCP with a half-close and EOF, and closes the connection", async () => {
    const log: string[] = [];
    expect(await run(["connect", "tcp", "127.0.0.1", "5432"], echoNetwork(log), "ping\0")).toEqual({ status: 0, stdout: "PING\0", stderr: "" });
    expect(log).toEqual(["tcp 127.0.0.1:5432", "closeWrite", "close"]);
  });

  it("asks the VM for TLS when the program does", async () => {
    const log: string[] = [];
    expect((await run(["connect", "tls", "example.com", "443"], echoNetwork(log), "x")).status).toBe(0);
    expect(log[0]).toBe("tcp example.com:443 tls");
  });

  it("keeps a missing socket (NotFound) apart from a refused one (ConnectionRefused)", async () => {
    expect((await run(["connect", "unix", "/run/missing.sock"], echoNetwork([]))).stderr).toMatch(/^rust-bridge-demo: NotFound: /u);
    expect((await run(["connect", "unix", "/run/refused.sock"], echoNetwork([]))).stderr).toMatch(/^rust-bridge-demo: ConnectionRefused: /u);
    expect((await run(["connect", "unix", "/run/db.sock"], echoNetwork([]), "q")).stdout).toBe("Q");
  });

  it("is Unsupported without a network reach, and nothing connects", async () => {
    expect((await run(["connect", "tcp", "127.0.0.1", "80"], undefined)).stderr).toMatch(/^rust-bridge-demo: Unsupported: /u);
  });
});

describe("read timeouts across the Wasm boundary", () => {
  it("reads u32::MAX (an i32 -1 in JavaScript) as no timeout, never as a negative timeout", async () => {
    const seen: unknown[] = [];
    const network: NetSyncHost = { ...echoNetwork([]), connectSync: () => ({ write: () => undefined, closeWrite: () => undefined, close: () => undefined, alpn: null, read: (_max, options) => { seen.push(options); return new Uint8Array(); } }) };
    expect((await run(["connect", "tcp", "h", "1"], network)).status).toBe(0);
    expect(seen).toEqual([{}]);
  });
});
