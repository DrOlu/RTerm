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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

function detectBinaryPlatform(filePath) {
  if (!fs.existsSync(filePath)) {
    return "missing";
  }
  const header = Buffer.alloc(4);
  const fd = fs.openSync(filePath, "r");
  try {
    fs.readSync(fd, header, 0, 4, 0);
  } finally {
    fs.closeSync(fd);
  }
  // PE (Windows): starts with "MZ"
  if (header[0] === 0x4d && header[1] === 0x5a) {
    return "win32";
  }
  // Mach-O (macOS): magic 0xFEEDFACE / 0xFEEDFACF / fat binary 0xCAFEBABE
  if (
    (header[0] === 0xfe && header[1] === 0xed) ||
    (header[0] === 0xcf && header[1] === 0xfa) ||
    (header[0] === 0xce && header[1] === 0xfa) ||
    (header[0] === 0xca && header[1] === 0xfe)
  ) {
    return "darwin";
  }
  // ELF (Linux): starts with 0x7F "ELF"
  if (header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46) {
    return "linux";
  }
  return "unknown";
}

const { platform: targetPlatform, arch: targetArch } = parseArgs();
if (!targetPlatform || !targetArch) {
  console.log(
    "[ensure-better-sqlite3-target-prebuilt] No --platform/--arch specified, skipping."
  );
  process.exit(0);
}

if (isHostMatch(targetPlatform, targetArch)) {
  console.log(
    `[ensure-better-sqlite3-target-prebuilt] Target ${targetPlatform}-${targetArch} matches host, skipping.`
  );
  process.exit(0);
}

// Check if the current binary already matches the target platform.
const currentPlatform = detectBinaryPlatform(nodeFilePath);
if (currentPlatform === targetPlatform) {
  console.log(
    `[ensure-better-sqlite3-target-prebuilt] Binary already targets ${targetPlatform}, skipping.`
  );
  process.exit(0);
}

console.log(
  `[ensure-better-sqlite3-target-prebuilt] Current binary is ${currentPlatform}, downloading prebuild for ${targetPlatform}-${targetArch} (Electron ${electronVersion})...`
);

const npxBin = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  npxBin,
  [
    "prebuild-install",
    "--platform", targetPlatform,
    "--arch", targetArch,
    "--runtime", "electron",
    "--target", electronVersion,
    "--tag-prefix", "v",
  ],
  {
    cwd: modulePath,
    env: { ...process.env },
    encoding: "utf8",
    stdio: "inherit",
  }
);

if (result.status !== 0) {
  console.error(
    `[ensure-better-sqlite3-target-prebuilt] Failed to download prebuild for ${targetPlatform}-${targetArch}.`
  );
  process.exit(result.status ?? 1);
}

// Verify the downloaded binary matches the target platform.
const verifiedPlatform = detectBinaryPlatform(nodeFilePath);
if (verifiedPlatform !== targetPlatform) {
  console.error(
    `[ensure-better-sqlite3-target-prebuilt] Downloaded binary is ${verifiedPlatform}, expected ${targetPlatform}. Prebuild may be corrupt.`
  );
  process.exit(1);
}

console.log(
  `[ensure-better-sqlite3-target-prebuilt] Successfully installed ${targetPlatform}-${targetArch} prebuild.`
);
