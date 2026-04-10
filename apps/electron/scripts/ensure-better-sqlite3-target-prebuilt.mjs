/**
 * Downloads the correct prebuild of better-sqlite3-electron for the target
 * platform when cross-building Electron packages.
 *
 * Usage:
 *   node ensure-better-sqlite3-target-prebuilt.mjs --platform win32 --arch x64
 *
 * When the target matches the current host platform+arch the script is a no-op
 * (the postinstall electron-rebuild has already produced the correct binary).
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatNativeBinaryIdentity,
  inspectNativeBinary,
  matchesNativeBinaryTarget,
} from "./native-binary-utils.mjs";

const require = createRequire(import.meta.url);

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const modulePath = path.join(repoRoot, "node_modules", "better-sqlite3-electron");
const nodeFilePath = path.join(modulePath, "build", "Release", "better_sqlite3.node");

const electronPkg = require("electron/package.json");
const electronVersion = electronPkg.version;

function parseArgs() {
  const args = process.argv.slice(2);
  let platform = null;
  let arch = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--platform" && args[i + 1]) {
      platform = args[++i];
    } else if (args[i] === "--arch" && args[i + 1]) {
      arch = args[++i];
    }
  }
  return { platform, arch };
}

function isHostMatch(targetPlatform, targetArch) {
  return targetPlatform === process.platform && targetArch === process.arch;
}

const { platform: targetPlatform, arch: targetArch } = parseArgs();
if (!targetPlatform || !targetArch) {
  console.log(
    "[ensure-better-sqlite3-target-prebuilt] No --platform/--arch specified, skipping."
  );
  process.exit(0);
}

const currentIdentity = inspectNativeBinary(nodeFilePath);

console.log(
  `[ensure-better-sqlite3-target-prebuilt] Current binary is ${formatNativeBinaryIdentity(currentIdentity)}, preparing ${targetPlatform}-${targetArch} (Electron ${electronVersion})...`
);

const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
const ensureHostScriptPath = path.join(
  scriptDir,
  "ensure-better-sqlite3-electron.mjs",
);

const run = (command, args) =>
  spawnSync(command, args, {
    cwd: modulePath,
    env: { ...process.env },
    encoding: "utf8",
    stdio: "inherit",
  });

if (isHostMatch(targetPlatform, targetArch)) {
  const prebuildResult = run(npxBin, [
    "prebuild-install",
    "--platform",
    targetPlatform,
    "--arch",
    targetArch,
    "--runtime",
    "electron",
    "--target",
    electronVersion,
    "--tag-prefix",
    "v",
  ]);

  if (prebuildResult.status !== 0) {
    console.warn(
      `[ensure-better-sqlite3-target-prebuilt] Prebuild download failed for host target ${targetPlatform}-${targetArch}; falling back to electron rebuild verification.`,
    );
  }

  const hostVerifyResult = spawnSync(process.execPath, [ensureHostScriptPath], {
    cwd: repoRoot,
    env: { ...process.env },
    encoding: "utf8",
    stdio: "inherit",
  });
  if (hostVerifyResult.status !== 0) {
    process.exit(hostVerifyResult.status ?? 1);
  }
} else {
  const crossTargetResult = run(npxBin, [
    "prebuild-install",
    "--platform",
    targetPlatform,
    "--arch",
    targetArch,
    "--runtime",
    "electron",
    "--target",
    electronVersion,
    "--tag-prefix",
    "v",
  ]);

  if (crossTargetResult.status !== 0) {
    console.error(
      `[ensure-better-sqlite3-target-prebuilt] Failed to download prebuild for ${targetPlatform}-${targetArch}.`
    );
    process.exit(crossTargetResult.status ?? 1);
  }
}

const verifiedIdentity = inspectNativeBinary(nodeFilePath);
if (!matchesNativeBinaryTarget(verifiedIdentity, targetPlatform, targetArch)) {
  console.error(
    `[ensure-better-sqlite3-target-prebuilt] Downloaded binary is ${formatNativeBinaryIdentity(verifiedIdentity)}, expected ${targetPlatform}-${targetArch}.`
  );
  process.exit(1);
}

console.log(
  `[ensure-better-sqlite3-target-prebuilt] Ready: ${formatNativeBinaryIdentity(verifiedIdentity)}.`
);
