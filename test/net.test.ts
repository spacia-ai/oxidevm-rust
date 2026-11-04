import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CommandIO } from "@oxidevm/sdk/wasm";
import { decodeDestination } from "../src/bridge/net.ts";
import { rustCommand, type RustCommandName } from "../src/command.ts";
import type { NetSyncHost, SyncConnection } from "../src/host.ts";
import { WasiError } from "../src/wasi/context.ts";
import { descriptor, FakeLinuxError, streams } from "./support/streams.ts";

const demo = new WebAssembly.Module(await readFile(new URL("../upstream/bridge-demo.wasm", import.meta.url)));
const io = (args: readonly string[]): CommandIO<RustCommandName> => ({ args, env: {}, cwd: "/workspace", stdin: descriptor(0), stdout: descriptor(1), stderr: descriptor(2), invocation: { kind: "host" }, terminals: { stdin: false, stdout: false, stderr: false } });

/** An echo peer: answers everything it received, upper-cased, once this side half-closes. */
function echoNetwork(log: string[]): NetSyncHost {
  const peer = (): SyncConnection => {
    const received: number[] = []; let closedWrite = false, answered = false;
    return {
      write: bytes => { if (closedWrite) throw new FakeLinuxError(32); received.push(...bytes); },
      closeWrite: () => { closedWrite = true; log.push("closeWrite"); },
      read: () => { if (!closedWrite || answered) return new Uint8Array(); answered = true; return Uint8Array.from(received.map(byte => byte >= 97 && byte <= 122 ? byte - 32 : byte)); },
      close: () => { log.push("close"); },
    };
  };
  return {
    connectSync: options => { log.push(`tcp ${options.host}:${String(options.port)}${options.tls === true ? " tls" : ""}`); return peer(); },
    connectUnixSync: path => {
      if (path === "/run/missing.sock") throw new FakeLinuxError(2);
      if (path === "/run/refused.sock") throw new FakeLinuxError(111);
      log.push(`unix ${path}`); return peer();
    },
    errno: error => error instanceof FakeLinuxError ? error.errno : 5,
  };
}
async function run(args: readonly string[], netSync: NetSyncHost | undefined, stdin = "") {
  const fake = streams({ stdin: new TextEncoder().encode(stdin), ...(netSync === undefined ? {} : { netSync }) });
  const status = await rustCommand(fake.host, demo, "rust-bridge-demo").main(io(args));
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
    const network: NetSyncHost = { ...echoNetwork([]), connectSync: () => ({ write: () => undefined, closeWrite: () => undefined, close: () => undefined, read: (_max, options) => { seen.push(options); return new Uint8Array(); } }) };
    expect((await run(["connect", "tcp", "h", "1"], network)).status).toBe(0);
    expect(seen).toEqual([{}]);
  });
});

describe("destination decoding", () => {
  const record = (...parts: readonly (number | string)[]) => {
    const out: number[] = [];
    for (const part of parts) {
      if (typeof part === "number") out.push(part);
      else { const bytes = new TextEncoder().encode(part); out.push(bytes.byteLength & 0xff, (bytes.byteLength >> 8) & 0xff, 0, 0, ...bytes); }
    }
    return Uint8Array.from(out);
  };
  it("decodes TCP, TLS with ALPN and Unix destinations exactly and refuses malformed ones", () => {
    expect(decodeDestination(record(0, "db", 0x38, 0x15))).toEqual({ kind: "tcp", host: "db", port: 5432, tls: false, alpn: [] });
    expect(decodeDestination(record(1, "h", 0xbb, 0x01, 1, 0, 0, 0, "h2"))).toEqual({ kind: "tcp", host: "h", port: 443, tls: true, alpn: ["h2"] });
    expect(decodeDestination(record(2, "/run/x.sock"))).toEqual({ kind: "unix", path: "/run/x.sock" });
    for (const bad of [record(3, "x"), record(0, "h", 0, 0), record(0, "", 1, 0), record(2, "/x", 9), record(2, "a".repeat(108))]) expect(() => decodeDestination(bad)).toThrow(WasiError);
  });
});
