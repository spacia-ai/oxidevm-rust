// The driver calls `runSuite` with the served engine and image; the suite's scenarios run in order on one VM.
import { enableModuleCommands } from "@oxidevm/sdk/wasm";
import { oxidevmRust } from "./oxidevm.modules.generated";
import { openVM, runAll, type Config } from "./support";
import { scenarios } from "./suite";

async function runSuite(config: Config) {
  // Suites that open further VMs (durability across a restart) read the served engine and image from here.
  Object.defineProperty(window, "suiteConfig", { value: config, configurable: true });
  const vm = await openVM(config);
  try {
    await vm.exec({ command: "/bin/mkdir", args: ["-p", "/workspace/t"], stdin: new Uint8Array() });
    const commands = await enableModuleCommands(vm, oxidevmRust);
    try { return await runAll(vm, scenarios); } finally { await commands.disable(); }
  } finally { await vm.dispose(); }
}
Object.defineProperty(window, "runSuite", { value: runSuite, enumerable: true });
