import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const NODE_RUNTIME_PACKAGE_NAME = "better-sqlite3";
const ELECTRON_RUNTIME_PACKAGE_NAME = "better-sqlite3-electron";

type BetterSqlite3Constructor = typeof import("better-sqlite3");

let cachedConstructor: BetterSqlite3Constructor | null = null;
let cachedPackageName: string | null = null;

function resolveRuntimePackageName(): string {
  return process.versions.electron
    ? ELECTRON_RUNTIME_PACKAGE_NAME
    : NODE_RUNTIME_PACKAGE_NAME;
}

export function loadBetterSqlite3(): BetterSqlite3Constructor {
  const packageName = resolveRuntimePackageName();
  if (cachedConstructor && cachedPackageName === packageName) {
    return cachedConstructor;
  }
  cachedConstructor = require(packageName) as BetterSqlite3Constructor;
  cachedPackageName = packageName;
  return cachedConstructor;
}
