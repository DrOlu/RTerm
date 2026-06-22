import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

const require = createRequire(import.meta.url);

const electronBinary = require("electron");
const electronVersion = require("electron/package.json").version;
const sqliteModulePath = path.dirname(
  require.resolve("better-sqlite3-electron/package.json"),
);
const npxBinary = process.platform === "win32" ? "npx.cmd" : "npx";
const checkArgs = [
  "-e",
  [
    "const Database = require('better-sqlite3-electron');",
    "const db = new Database(':memory:');",
    "db.exec('SELECT 1');",
    "db.close();",
    "console.log('better-sqlite3 electron ok');",
  ].join(" "),
];

function run(command, args, extraEnv = {}, cwd = process.cwd()) {
  return spawnSync(command, args, {
    cwd,
    env: {
      ...process.env,
      ...extraEnv,
    },
    encoding: "utf8",
    stdio: "pipe",
  });
}

function formatOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
}

function runElectronCheck() {
  return run(electronBinary, checkArgs, {
    ELECTRON_RUN_AS_NODE: "1",
  });
}

const check = runElectronCheck();

if (check.status === 0) {
  const output = formatOutput(check);
  if (output) {
    console.log(output);
  }
  process.exit(0);
}

console.warn(
  "[ensure-better-sqlite3-electron] Electron ABI check failed, restoring host prebuild...",
);
const prebuild = run(
  npxBinary,
  [
    "prebuild-install",
    "--platform",
    process.platform,
    "--arch",
    process.arch,
    "--runtime",
    "electron",
    "--target",
    electronVersion,
    "--tag-prefix",
    "v",
  ],
  {},
  sqliteModulePath,
);

if (prebuild.status === 0) {
  const prebuildVerify = runElectronCheck();
  if (prebuildVerify.status === 0) {
    const prebuildVerifyOutput = formatOutput(prebuildVerify);
    if (prebuildVerifyOutput) {
      console.log(prebuildVerifyOutput);
    }
    process.exit(0);
  }

  const prebuildVerifyOutput = formatOutput(prebuildVerify);
  if (prebuildVerifyOutput) {
    console.warn(prebuildVerifyOutput);
  }
} else {
  const prebuildOutput = formatOutput(prebuild);
  if (prebuildOutput) {
    console.warn(prebuildOutput);
  }
}

console.warn(
  "[ensure-better-sqlite3-electron] Host prebuild did not verify, rebuilding better-sqlite3...",
);
const rebuild = run(npxBinary, [
  "electron-rebuild",
  "-f",
  "-o",
  "better-sqlite3-electron",
]);
if (rebuild.status !== 0) {
  const rebuildOutput = formatOutput(rebuild);
  if (rebuildOutput) {
    console.error(rebuildOutput);
  }
  process.exit(rebuild.status ?? 1);
}

const verify = runElectronCheck();
if (verify.status !== 0) {
  const verifyOutput = formatOutput(verify);
  if (verifyOutput) {
    console.error(verifyOutput);
  }
  process.exit(verify.status ?? 1);
}

const verifyOutput = formatOutput(verify);
if (verifyOutput) {
  console.log(verifyOutput);
}
