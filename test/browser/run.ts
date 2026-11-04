// Real-engine browser tests: builds this module, installs it into a fresh consumer project with the real CLI
// (`oxidevm wasm add file:vendor/rust`), type-checks the page against the generated handles, builds it with Vite, serves
// it with the SDK's pinned engine and a signed Userspace image, and runs one suite in Chromium or Firefox.
//
//   OXIDEVM_TEST_USERSPACE_IMAGE=<image reference JSON> OXIDEVM_TEST_USERSPACE_IMAGE_DIR=<bundle directory> \
//     node test/browser/run.ts <suite> [--browser chromium|firefox]
//
// The reference JSON is { "mode": "userspace", "manifestUrl", "manifestSHA256", "trust" }. The image needs a POSIX sh,
// coreutils-style tools (head, cmp, sha256sum, sleep, kill), gzip and Python for later suites. Results go to
// test-results/<suite>-<browser>.json.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { chromium, firefox, type Browser } from "playwright";
import { build } from "vite";
import { decodeProjectConfig, getSDKRelease, pinnedEngineCompliance } from "@oxidevm/sdk/image-builder";

const execute = promisify(execFile);
const { values: flags, positionals } = parseArgs({ options: { browser: { type: "string", default: "chromium" } }, allowPositionals: true, strict: true });
const suite = positionals[0];
if (suite === undefined || !/^[a-z-]+$/u.test(suite)) throw new Error("usage: node test/browser/run.ts <suite> [--browser chromium|firefox]");
if (flags.browser !== "chromium" && flags.browser !== "firefox") throw new Error(`Unsupported browser ${flags.browser}`);
const browserName = flags.browser;
const root = resolve(import.meta.dirname, "../..");
const imageFile = process.env["OXIDEVM_TEST_USERSPACE_IMAGE"], imageDir = process.env["OXIDEVM_TEST_USERSPACE_IMAGE_DIR"];
if (imageFile === undefined || imageDir === undefined) {
  process.stderr.write("Set OXIDEVM_TEST_USERSPACE_IMAGE (an image reference JSON) and OXIDEVM_TEST_USERSPACE_IMAGE_DIR (its bundle directory).\n");
  process.exit(2);
}
const sdk = join(root, "node_modules/@oxidevm/sdk");
const cli = join(root, "node_modules/@oxidevm/cli/dist/bin.js");
const engineDir = process.env["OXIDEVM_ENGINE_DIR"] ?? join(homedir(), ".cache/oxidevm/engine", getSDKRelease().engineRelease.replace(/^sha256:/u, ""));
const compliance = pinnedEngineCompliance();
const complianceDir = compliance === null ? undefined : join(homedir(), ".cache/oxidevm/engine/compliance", compliance.sha256);
for (const path of [cli, engineDir, imageDir, join(root, "test/browser/suites", `${suite}.ts`)]) await stat(path);

await execute(process.execPath, [cli, "wasm", "build", "--project", root], { cwd: root });
const output = await mkdtemp(join(tmpdir(), `oxidevm-rust-${suite}-`));
const project = join(output, "project");
await mkdir(join(project, "src"), { recursive: true });
await mkdir(join(project, "node_modules/@oxidevm"), { recursive: true });
await symlink(sdk, join(project, "node_modules/@oxidevm/sdk"));
await writeFile(join(project, "package.json"), `${JSON.stringify({ name: "oxidevm-rust-browser-test", private: true, type: "module" }, null, 2)}\n`);
await cp(join(root, "dist"), join(project, "vendor/rust"), { recursive: true });
await cp(join(root, "test/browser/page/index.html"), join(project, "index.html"));
await cp(join(root, "test/browser/page/tsconfig.json"), join(project, "tsconfig.json"));
await cp(join(root, "test/browser/page/main.ts"), join(project, "src/main.ts"));
await cp(join(root, "test/browser/page/support.ts"), join(project, "src/support.ts"));
await cp(join(root, "test/browser/suites", `${suite}.ts`), join(project, "src/suite.ts"));
// The Rust fixtures, served beside the page so a suite can copy them into the VM and run them with rust-wasi.
await mkdir(join(project, "public/fixtures"), { recursive: true });
for (const name of ["fixture-import-probe", "fixture-binary-echo", "fixture-identity", "fixture-fsops"]) {
  await cp(join(root, "target/wasm32-wasip1/release", `${name}.wasm`), join(project, "public/fixtures", `${name}.wasm`));
}
const added = await execute(process.execPath, [cli, "wasm", "add", "file:vendor/rust", "--yes", "--project", project, "--json"], { cwd: project });
assert(added.stdout.includes('"kind":"result"'), `wasm add: ${added.stdout}`);
await execute(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(project, "tsconfig.json")], { cwd: project, maxBuffer: 16 * 1024 ** 2 }).catch((error: unknown) => {
  throw new Error(`the page does not type-check:\n${error instanceof Error && "stdout" in error ? String(error.stdout) : String(error)}`, { cause: error });
});
const dist = join(output, "dist");
await build({ root: project, configFile: false, logLevel: "warn", base: "/page/", build: { outDir: dist, emptyOutDir: true, target: "esnext", assetsInlineLimit: 0 }, worker: { format: "es" } });

const referenceJSON: unknown = JSON.parse(await readFile(imageFile, "utf8"));
const reference = decodeProjectConfig({ mode: "userspace", image: referenceJSON }).image;
assert(reference !== undefined, "The image reference JSON is not a signed image reference");
const imagePrefix = `${dirname(new URL(reference.manifestUrl, "http://x").pathname)}/`;
const moduleFrameDir = join(sdk, "assets/module-frame");
const frame: unknown = JSON.parse(await readFile(join(moduleFrameDir, "frame.json"), "utf8"));
const frameHeaders: unknown = typeof frame === "object" && frame !== null ? Reflect.get(frame, "headers") : undefined;
assert(typeof frameHeaders === "object" && frameHeaders !== null, "the SDK's module-frame/frame.json has no headers");
const types: Readonly<Record<string, string>> = { ".wasm": "application/wasm", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".html": "text/html" };
const server = createServer((request, response) => {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (path.startsWith("/engine/module-frame/")) {
    const name = path.slice("/engine/module-frame/".length) || "index.html";
    if (!["index.html", "broker.js", "runner.js"].includes(name)) { response.writeHead(404); response.end(); return; }
    for (const [header, value] of Object.entries(frameHeaders)) response.setHeader(header, String(value));
    response.setHeader("Content-Type", name.endsWith(".html") ? "text/html" : "text/javascript");
    createReadStream(join(moduleFrameDir, name)).pipe(response);
    return;
  }
  for (const [name, value] of [["Cross-Origin-Opener-Policy", "same-origin"], ["Cross-Origin-Embedder-Policy", "require-corp"], ["Cross-Origin-Resource-Policy", "same-origin"]] as const) response.setHeader(name, value);
  const file = path.startsWith("/engine/compliance/") && complianceDir !== undefined ? join(complianceDir, path.slice("/engine/compliance/".length + 65))
    : path.startsWith("/engine/") ? join(engineDir, path.slice("/engine/".length))
    : path.startsWith(imagePrefix) ? join(imageDir, path.slice(imagePrefix.length))
    : path.startsWith("/page/") ? join(dist, path.slice("/page/".length) === "" ? "index.html" : path.slice("/page/".length)) : undefined;
  response.setHeader("Content-Type", types[extname(path)] ?? "application/octet-stream");
  if (file === undefined || file.includes("..")) { response.writeHead(404); response.end(); return; }
  const stream = createReadStream(file);
  stream.on("error", () => { response.writeHead(404); response.end(); });
  stream.pipe(response);
});
await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
const address = server.address();
assert(address !== null && typeof address !== "string");
const origin = `http://127.0.0.1:${String(address.port)}`;
const image = { manifestUrl: new URL(reference.manifestUrl, origin).href, manifestSHA256: reference.manifestSHA256, trust: reference.trust };

interface Result { readonly name: string; readonly ok: boolean; readonly detail: string }
function decodeResults(value: unknown): readonly Result[] {
  assert(Array.isArray(value), "The page returned no results");
  return Array.from<unknown>(value).map(entry => {
    assert(typeof entry === "object" && entry !== null, "A result is not an object");
    const name: unknown = Reflect.get(entry, "name"), ok: unknown = Reflect.get(entry, "ok"), detail: unknown = Reflect.get(entry, "detail");
    assert(typeof name === "string" && typeof ok === "boolean" && typeof detail === "string", "A result has the wrong fields");
    return { name, ok, detail };
  });
}
const launch = (): Promise<Browser> => browserName === "chromium" ? chromium.launch({ headless: true }) : firefox.launch({ headless: true });
const browser = await launch(), version = browser.version();
process.stdout.write(`${suite}: ${browserName} ${version}\n`);
let results: readonly Result[];
try {
  const tab = await browser.newPage();
  tab.setDefaultTimeout(900_000);
  tab.on("console", message => { if (process.env["OXIDEVM_VERBOSE"] !== undefined) process.stderr.write(`browser: ${message.text()}\n`); });
  tab.on("pageerror", error => { process.stderr.write(`page error: ${error.message}\n`); });
  await tab.goto(`${origin}/page/index.html`);
  results = decodeResults(await tab.evaluate(async (input: { origin: string; image: typeof image }) => {
    const run: unknown = Reflect.get(window, "runSuite");
    if (typeof run !== "function") throw new Error("The page did not register runSuite");
    const outcome: unknown = await Reflect.apply(run, undefined, [input]);
    return outcome;
  }, { origin, image }));
} finally {
  await browser.close();
  server.close();
  await rm(output, { recursive: true, force: true });
}
let failed = 0;
for (const result of results) {
  if (!result.ok) failed += 1;
  process.stdout.write(`${result.ok ? "PASS" : "FAIL"}  ${result.name}\n      ${result.detail}\n`);
}
await mkdir(join(root, "test-results"), { recursive: true });
await writeFile(join(root, `test-results/${suite}-${browserName}.json`), `${JSON.stringify({ suite, browser: browserName, version, engine: getSDKRelease().engineRelease, image: reference.manifestSHA256, results }, null, 2)}\n`);
process.stdout.write(`\n${String(results.length - failed)} of ${String(results.length)} passed\n`);
process.exitCode = failed === 0 && results.length > 0 ? 0 : 1;
