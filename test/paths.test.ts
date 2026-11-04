import { describe, expect, it } from "vitest";
import { WASI } from "../src/errno.ts";
import { rootPath } from "../src/wasi/preview1.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

describe("paths beneath the root preopen (OBL-PATH-BYTES, root preopen)", () => {
  it("joins a relative path to / and keeps an absolute one", () => {
    expect(rootPath(bytes("workspace/a b"))).toBe("/workspace/a b");
    expect(rootPath(bytes("/workspace"))).toBe("/workspace");
    expect(rootPath(bytes(""))).toBe("/");
  });

  it("accepts 4095 bytes and refuses 4096", () => {
    expect(rootPath(bytes("a".repeat(4095)))).toBe(`/${"a".repeat(4095)}`);
    expect(rootPath(bytes("a".repeat(4096)))).toBe(WASI.nametoolong);
  });

  it("refuses an embedded NUL and invalid UTF-8 without replacing bytes", () => {
    expect(rootPath(Uint8Array.of(0x61, 0x00, 0x62))).toBe(WASI.inval);
    expect(rootPath(Uint8Array.of(0x61, 0xff))).toBe(WASI.ilseq);
  });
});
