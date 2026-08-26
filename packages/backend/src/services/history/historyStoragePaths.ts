import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const HISTORY_SQLITE_FILE_NAME = "gyshell-history.sqlite";
export const LEGACY_CHAT_HISTORY_FILE_NAME = "gyshell-chat-history.json";
export const LEGACY_UI_HISTORY_FILE_NAME = "gyshell-ui-history.json";

export interface HistoryStoragePaths {
  baseDir: string;
  sqliteDbPath: string;
  legacyChatHistoryPath: string;
  legacyUiHistoryPath: string;
}

export function resolveHistoryStorageDir(): string {
  const overrideDir = (process.env.GYSHELL_STORE_DIR || "").trim();
  if (overrideDir) {
    return path.resolve(overrideDir);
  }
  // v3.2.18 fix: the daemon may run with cwd=/ (launchd), which previously
  // resolved to /.gybackend-data — an empty store that silently diverged from
  // the user's real data at ~/.gybackend-data. Prefer the home directory so
  // history is found regardless of the process working directory.
  const gybackendDataDir = (process.env.GYBACKEND_DATA_DIR || "").trim();
  if (gybackendDataDir) {
    return path.resolve(gybackendDataDir);
  }
  return path.join(os.homedir(), ".gybackend-data");
}

export function ensureHistoryStorageDir(
  baseDir: string = resolveHistoryStorageDir(),
): string {
  fs.mkdirSync(baseDir, { recursive: true });
  return baseDir;
}

export function resolveHistoryStoragePaths(
  baseDir: string = resolveHistoryStorageDir(),
): HistoryStoragePaths {
  const resolvedBaseDir = ensureHistoryStorageDir(baseDir);
  return {
    baseDir: resolvedBaseDir,
    sqliteDbPath: path.join(resolvedBaseDir, HISTORY_SQLITE_FILE_NAME),
    legacyChatHistoryPath: path.join(
      resolvedBaseDir,
      LEGACY_CHAT_HISTORY_FILE_NAME,
    ),
    legacyUiHistoryPath: path.join(
      resolvedBaseDir,
      LEGACY_UI_HISTORY_FILE_NAME,
    ),
  };
}
