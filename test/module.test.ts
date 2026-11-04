import { describe, expect, it } from "vitest";
import definition from "../module.ts";

describe("module definition", () => {
  it("declares what the build and the consumer read", () => {
    expect(definition.manifest.id).toBe("oxidevm-rust");
    expect(definition.manifest.abi).toBe("wasi");
    expect(definition.manifest.process.kind).toBe("command");
    expect(definition.manifest.commands).toEqual(["rust-bridge-demo", "rust-wasi"]);
    // Files and the process's own identity; native processes (SL-06) and networking (SL-07) add theirs when they land.
    expect(definition.manifest.requires.host).toEqual(["files.sync", "process.info"]);
  });
});
