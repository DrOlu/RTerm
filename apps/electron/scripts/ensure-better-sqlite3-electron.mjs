import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import process from "node:process";

const require = createRequire(import.meta.url);

const electronBinary = require("electron");
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

function run(command, args, extraEnv = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
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

const check = run(electronBinary, checkArgs, {
  ELECTRON_RUN_AS_NODE: "1",
});

if (check.status === 0) {
  const output = formatOutput(check);
  if (output) {
    console.log(output);
  }
  process.exit(0);
}

console.warn(
  "[ensure-better-sqlite3-electron] Electron ABI check failed, rebuilding better-sqlite3...",
);
const rebuild = run(npxBinary, [
  "electron-rebuild",
  "-f",
  "-w",
  "better-sqlite3-electron",
]);
if (rebuild.status !== 0) {
  const rebuildOutput = formatOutput(rebuild);
  if (rebuildOutput) {
    console.error(rebuildOutput);
  }
  process.exit(rebuild.status ?? 1);
}

const verify = run(electronBinary, checkArgs, {
  ELECTRON_RUN_AS_NODE: "1",
});
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
