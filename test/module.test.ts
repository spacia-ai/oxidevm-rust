import { describe, expect, it } from "vitest";
import definition from "../module.ts";

describe("module definition", () => {
  it("declares what the build and the consumer read", () => {
    expect(definition.manifest.id).toBe("oxidevm-rust");
    expect(definition.manifest.abi).toBe("wasi");
    expect(definition.manifest.process.kind).toBe("command");
    expect(definition.manifest.commands).toEqual(["rust-bridge-demo", "rust-wasi"]);
    // Files (descriptor-relative), the VM clock and entropy, the process's identity, synchronous native children and
    // VM-only network reach: exactly what the WASI adapter and the bridge use.
    expect(definition.manifest.requires.host).toEqual(["files.sync", "files.at", "clock", "random", "process.info", "process.sync", "net.vm"]);
  });
});
