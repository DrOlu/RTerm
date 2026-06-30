import { createRequire } from "node:module";
import prunePackagedRuntime from "./prune-packaged-runtime.mjs";
import validateBetterSqlite3Runtime from "./validate-better-sqlite3-runtime.mjs";
import validateWindowsNodePtyRuntime from "./validate-windows-node-pty-runtime.mjs";

const require = createRequire(import.meta.url);
const applySandboxFix = require("electron-builder-sandbox-fix");

export default async function afterPack(context) {
  // gyll/CLI TUI is deprecated and no longer bundled with desktop packages.
  await prunePackagedRuntime(context);
  await validateBetterSqlite3Runtime(context);
  await validateWindowsNodePtyRuntime(context);

  if (context?.electronPlatformName === "linux") {
    await applySandboxFix(context);
  }
}
