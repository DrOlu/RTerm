import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export interface PassChatTempExportInput {
  sessionId: string;
  title: string;
  markdown: string;
}

export interface PassChatTempExportOptions {
  baseDir?: string;
  maxFiles?: number | null;
  groupBySession?: boolean;
}

const DEFAULT_MAX_FILES = 50;

export class PassChatTempExportService {
  private readonly baseDir: string;
  private readonly maxFiles: number | null;
  private readonly groupBySession: boolean;

  constructor(options?: PassChatTempExportOptions) {
    this.baseDir =
      options?.baseDir || path.join(os.tmpdir(), "gyshell-pass-chats");
    this.maxFiles =
      options?.maxFiles === null
        ? null
        : Number.isInteger(options?.maxFiles) && Number(options?.maxFiles) > 0
          ? Number(options?.maxFiles)
          : DEFAULT_MAX_FILES;
    this.groupBySession = options?.groupBySession === true;
  }

  async exportMarkdown(input: PassChatTempExportInput): Promise<string> {
    await this.ensurePrivateBaseDir();
    const filePath = this.buildFilePath(input);
    await fs.writeFile(filePath, input.markdown, {
      encoding: "utf8",
      mode: 0o600,
    });
    await this.chmodFileOwnerOnly(filePath);
    await this.cleanupIfNeeded();
    return filePath;
  }

  exportMarkdownSync(input: PassChatTempExportInput): string {
    this.ensurePrivateBaseDirSync();
    const filePath = this.buildFilePath(input);
    fsSync.writeFileSync(filePath, input.markdown, {
      encoding: "utf8",
      mode: 0o600,
    });
    this.chmodFileOwnerOnlySync(filePath);
    this.cleanupIfNeededSync();
    return filePath;
  }

  deleteExportsForSession(sessionId: string): void {
    if (!this.groupBySession) return;
    const sessionHash = this.hashText(sessionId).slice(0, 12);
    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(this.baseDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (
        !entry.isFile() ||
        !entry.name.startsWith(`pass-chat_${sessionHash}_`) ||
        !entry.name.endsWith(".md")
      ) {
        continue;
      }
      try {
        fsSync.unlinkSync(path.join(this.baseDir, entry.name));
      } catch {
        // Best-effort cleanup only.
      }
    }
  }

  readManagedMarkdownSync(filePath: string): string | null {
    const resolvedPath = this.resolveManagedExportPath(filePath);
    if (!resolvedPath) return null;

    try {
      const stat = fsSync.lstatSync(resolvedPath);
      if (!stat.isFile()) return null;
      return fsSync.readFileSync(resolvedPath, "utf8");
    } catch {
      return null;
    }
  }

  readManagedMarkdownForSessionSync(
    filePath: string,
    sessionId: string,
  ): string | null {
    const resolvedPath = this.resolveManagedExportPath(filePath, sessionId);
    if (!resolvedPath) return null;

    try {
      const stat = fsSync.lstatSync(resolvedPath);
      if (!stat.isFile()) return null;
      return fsSync.readFileSync(resolvedPath, "utf8");
    } catch {
      return null;
    }
  }

  isManagedExportPath(filePath: string): boolean {
    return this.resolveManagedExportPath(filePath) !== null;
  }

  isManagedExportPathForSession(filePath: string, sessionId: string): boolean {
    return this.resolveManagedExportPath(filePath, sessionId) !== null;
  }

  deleteManagedExportPath(filePath: string): void {
    const resolvedPath = this.resolveManagedExportPath(filePath);
    if (!resolvedPath) return;
    try {
      fsSync.unlinkSync(resolvedPath);
    } catch {
      // Best-effort cleanup only.
    }
  }

  deleteManagedExportPathForSession(filePath: string, sessionId: string): void {
    const resolvedPath = this.resolveManagedExportPath(filePath, sessionId);
    if (!resolvedPath) return;
    try {
      fsSync.unlinkSync(resolvedPath);
    } catch {
      // Best-effort cleanup only.
    }
  }

  private resolveManagedExportPath(
    filePath: string,
    sessionId?: string,
  ): string | null {
    const resolvedBaseDir = path.resolve(this.baseDir);
    const resolvedPath = path.resolve(filePath);
    if (path.dirname(resolvedPath) !== resolvedBaseDir) {
      return null;
    }

    const fileName = path.basename(resolvedPath);
    const pattern = this.groupBySession
      ? /^pass-chat_[a-f0-9]{12}_[a-f0-9]{12}\.md$/
      : /^pass-chat_[a-f0-9]{12}\.md$/;
    if (!pattern.test(fileName)) return null;

    if (sessionId !== undefined) {
      if (!this.groupBySession) return null;
      const sessionHash = this.hashText(sessionId).slice(0, 12);
      if (!fileName.startsWith(`pass-chat_${sessionHash}_`)) {
        return null;
      }
    }

    return resolvedPath;
  }

  private buildFilePath(input: PassChatTempExportInput): string {
    const hash = this.hashText(
      `${input.sessionId}\n${input.title}\n${input.markdown}`,
    ).slice(0, 12);
    if (!this.groupBySession) {
      return path.join(this.baseDir, `pass-chat_${hash}.md`);
    }
    const sessionHash = this.hashText(input.sessionId).slice(0, 12);
    return path.join(this.baseDir, `pass-chat_${sessionHash}_${hash}.md`);
  }

  private hashText(input: string): string {
    return crypto.createHash("sha256").update(input).digest("hex");
  }

  private async ensurePrivateBaseDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await this.chmodDirectoryOwnerOnly(this.baseDir);
  }

  private ensurePrivateBaseDirSync(): void {
    fsSync.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 });
    this.chmodDirectoryOwnerOnlySync(this.baseDir);
  }

  private async chmodDirectoryOwnerOnly(dirPath: string): Promise<void> {
    try {
      await fs.chmod(dirPath, 0o700);
    } catch {
      // Some filesystems do not support chmod; exported files are still written 0600 when supported.
    }
  }

  private chmodDirectoryOwnerOnlySync(dirPath: string): void {
    try {
      fsSync.chmodSync(dirPath, 0o700);
    } catch {
      // Some filesystems do not support chmod; exported files are still written 0600 when supported.
    }
  }

  private async chmodFileOwnerOnly(filePath: string): Promise<void> {
    try {
      await fs.chmod(filePath, 0o600);
    } catch {
      // Some filesystems do not support chmod; the file still lives in the OS temp directory.
    }
  }

  private chmodFileOwnerOnlySync(filePath: string): void {
    try {
      fsSync.chmodSync(filePath, 0o600);
    } catch {
      // Some filesystems do not support chmod; the file still lives in the configured export directory.
    }
  }

  private async cleanupIfNeeded(): Promise<void> {
    if (this.maxFiles === null) return;

    let entries;
    try {
      entries = await fs.readdir(this.baseDir, { withFileTypes: true });
    } catch {
      return;
    }

    const files = (
      await Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              entry.name.startsWith("pass-chat_") &&
              entry.name.endsWith(".md"),
          )
          .map(async (entry) => {
            const filePath = path.join(this.baseDir, entry.name);
            try {
              const stat = await fs.stat(filePath);
              return { filePath, mtimeMs: stat.mtimeMs };
            } catch {
              return null;
            }
          }),
      )
    ).filter((item): item is { filePath: string; mtimeMs: number } => !!item);

    if (files.length <= this.maxFiles) return;

    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const staleFiles = files.slice(this.maxFiles);
    await Promise.all(
      staleFiles.map((item) =>
        fs.unlink(item.filePath).catch(() => {
          // Best-effort cleanup only.
        }),
      ),
    );
  }

  private cleanupIfNeededSync(): void {
    if (this.maxFiles === null) return;

    let entries: fsSync.Dirent[];
    try {
      entries = fsSync.readdirSync(this.baseDir, { withFileTypes: true });
    } catch {
      return;
    }

    const files = entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith("pass-chat_") &&
          entry.name.endsWith(".md"),
      )
      .map((entry) => {
        const filePath = path.join(this.baseDir, entry.name);
        try {
          const stat = fsSync.statSync(filePath);
          return { filePath, mtimeMs: stat.mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((item): item is { filePath: string; mtimeMs: number } => !!item);

    if (files.length <= this.maxFiles) return;

    files.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const staleFiles = files.slice(this.maxFiles);
    for (const item of staleFiles) {
      try {
        fsSync.unlinkSync(item.filePath);
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}
