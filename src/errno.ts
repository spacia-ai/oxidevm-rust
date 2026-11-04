/** WASI Preview1 errno values (wasi_snapshot_preview1.witx `errno`). */
export const WASI = {
  success: 0, toobig: 1, acces: 2, again: 6, badf: 8, exist: 20, fault: 21, fbig: 22, intr: 27, inval: 28, io: 29, isdir: 31,
  loop: 32, mfile: 33, nametoolong: 37, noent: 44, nospc: 51, nosys: 52, notdir: 54, notempty: 55, notsup: 58,
  noexec: 45, overflow: 61, perm: 63, pipe: 64, rofs: 69, spipe: 70, timedout: 73, notcapable: 76, ilseq: 25, nomem: 48,
} as const;
export type WasiErrno = (typeof WASI)[keyof typeof WASI];

/** Linux errno → WASI errno. A Linux error with no WASI name becomes `io`, never success. */
const FROM_LINUX: ReadonlyMap<number, WasiErrno> = new Map<number, WasiErrno>([
  [1, WASI.perm], [2, WASI.noent], [4, WASI.intr], [5, WASI.io], [7, WASI.toobig], [8, WASI.noexec], [9, WASI.badf], [11, WASI.again],
  [12, WASI.nomem], [13, WASI.acces], [14, WASI.fault], [17, WASI.exist], [27, WASI.fbig], [20, WASI.notdir], [21, WASI.isdir],
  [22, WASI.inval], [24, WASI.mfile], [28, WASI.nospc], [29, WASI.spipe], [30, WASI.rofs], [32, WASI.pipe],
  [36, WASI.nametoolong], [38, WASI.nosys], [39, WASI.notempty], [40, WASI.loop], [75, WASI.overflow], [84, WASI.ilseq],
  [95, WASI.notsup], [110, WASI.timedout],
]);

export function wasiErrno(linuxErrno: number): WasiErrno {
  return FROM_LINUX.get(linuxErrno) ?? WASI.io;
}
