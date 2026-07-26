import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// createRequire works in both ESM (import.meta.url) and CJS (__filename) contexts.
// In the standalone CJS bundle, __filename is defined; in ESM source, import.meta.url is used.
const require = createRequire(
  typeof __filename !== "undefined" ? __filename : import.meta.url,
);

const NODE_RUNTIME_PACKAGE_NAME = "better-sqlite3";
const ELECTRON_RUNTIME_PACKAGE_NAME = "better-sqlite3-electron";

type BetterSqlite3Constructor = typeof import("better-sqlite3");
type BetterSqlite3OpenOptions = ConstructorParameters<BetterSqlite3Constructor>[1];
type DatabaseHandle = InstanceType<typeof import("better-sqlite3")>;

let cachedConstructor: BetterSqlite3Constructor | null = null;
let cachedPackageName: string | null = null;
let nativeBindingIsConstructor = false;

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
  // FIRST: try the executable's own directory (for a Node SEA single-binary build where the
  // native .node file ships alongside the exe, not embedded — SEA cannot require() embedded
  // .node files). This is the path when the binary is deployed as neuralos.exe + better_sqlite3.node.
  try {
    const exeDir = path.dirname(process.execPath);
    const candidate = path.join(exeDir, 'better_sqlite3.node');
    if (fs.existsSync(candidate)) {
      const m = require(candidate) as unknown as Record<string, unknown> | BetterSqlite3Constructor;
      // The .node file returns an object with Database/Statement keys — the constructor is m.Database.
      cachedConstructor = (typeof m === 'function' ? m : (m as Record<string, unknown>).Database) as BetterSqlite3Constructor;
      cachedPackageName = packageName;
      nativeBindingIsConstructor = true;
      return cachedConstructor;
    }
  } catch {
    // fall through to the npm package resolution
  }
  try {
    cachedConstructor = require(packageName) as BetterSqlite3Constructor;
    cachedPackageName = packageName;
    nativeBindingIsConstructor = false;
    return cachedConstructor;
  } catch (e) {
    // In a Node SEA single-binary build, the npm package isn't available as a module,
    // and embedded .node files cannot be require()'d. Try the executable's directory again
    // as a fallback (in case the existsSync check raced), then report.
    const exeDir = path.dirname(process.execPath);
    const candidates = [
      path.join(exeDir, 'better_sqlite3.node'),
      'better_sqlite3.node',
      'native/win32-x64/better_sqlite3.node',
    ]
    let lastErr: unknown = e
    for (const candidate of candidates) {
      try {
        const m = require(candidate) as unknown as Record<string, unknown> | BetterSqlite3Constructor;
        cachedConstructor = (typeof m === 'function' ? m : (m as Record<string, unknown>).Database) as BetterSqlite3Constructor;
        cachedPackageName = packageName;
        nativeBindingIsConstructor = true;
        return cachedConstructor;
      } catch (e2) {
        lastErr = e2
      }
    }
    throw new Error(`better-sqlite3 is not available (tried npm package '${packageName}' and executable-dir binary): ${e instanceof Error ? e.message : String(e)} / ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`);
  }
}

function normalizePotentialAsarPath(filePath: string): string {
  return filePath
    .replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
    .replace(
      `${path.sep}node_modules.asar${path.sep}`,
      `${path.sep}node_modules.asar.unpacked${path.sep}`,
    );
}

function resolveNativeBindingCandidates(packageName: string): string[] {
  const candidates: string[] = [];

  if (process.versions.electron && process.resourcesPath) {
    candidates.push(
      path.join(
        process.resourcesPath,
        "native-modules",
        "better-sqlite3",
        "better_sqlite3.node",
      ),
    );
  }

  try {
    const packageJsonPath = require.resolve(`${packageName}/package.json`);
    const packageRoot = normalizePotentialAsarPath(path.dirname(packageJsonPath));
    candidates.push(path.join(packageRoot, "build", "Release", "better_sqlite3.node"));
  } catch {
    // Fall back to the package's default bindings lookup when explicit resolution is unavailable.
  }

  return Array.from(new Set(candidates));
}

function isNativeBindingLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes(".node") ||
    /dlopen/i.test(message) ||
    /mach-o/i.test(message) ||
    /elf/i.test(message) ||
    /win32 application/i.test(message) ||
    /compiled against a different node\.js version/i.test(message) ||
    /module did not self-register/i.test(message) ||
    /cannot find module/i.test(message) ||
    /was compiled against a different Node\.js version/i.test(message)
  );
}

function formatNativeLoadFailure(candidatePath: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${candidatePath}: ${detail}`;
}

export function openBetterSqlite3Database(
  filePath: string,
  options?: BetterSqlite3OpenOptions,
): DatabaseHandle {
  const BetterSqlite3 = loadBetterSqlite3();
  const packageName = resolveRuntimePackageName();
  const loadFailures: string[] = [];

  for (const candidatePath of resolveNativeBindingCandidates(packageName)) {
    if (!fs.existsSync(candidatePath)) {
      continue;
    }

    try {
      const addon = require(candidatePath);
      // When the constructor IS the native binding (loaded from the .node file), don't pass
      // nativeBinding — the .node constructor already has it. Only the npm package's JS wrapper
      // needs nativeBinding to know which .node file to load.
      return new BetterSqlite3(filePath, nativeBindingIsConstructor ? (options || {}) : { ...(options || {}), nativeBinding: addon });
    } catch (error) {
      if (!isNativeBindingLoadError(error)) {
        throw error;
      }
      loadFailures.push(formatNativeLoadFailure(candidatePath, error));
    }
  }

  try {
    return new BetterSqlite3(filePath, options);
  } catch (error) {
    if (loadFailures.length === 0) {
      throw error;
    }

    const defaultFailure = error instanceof Error ? error.message : String(error);
    throw new Error(
      [
        "Failed to load the SQLite native runtime.",
        ...loadFailures.map((entry) => `Tried ${entry}`),
        `Default runtime lookup failed: ${defaultFailure}`,
      ].join("\n"),
    );
  }
}
