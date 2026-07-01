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
  maxFiles?: number;
}

const DEFAULT_MAX_FILES = 50;

export class PassChatTempExportService {
  private readonly baseDir: string;
  private readonly maxFiles: number;

  constructor(options?: PassChatTempExportOptions) {
    this.baseDir =
      options?.baseDir || path.join(os.tmpdir(), "gyshell-pass-chats");
    this.maxFiles =
      Number.isInteger(options?.maxFiles) && Number(options?.maxFiles) > 0
        ? Number(options?.maxFiles)
        : DEFAULT_MAX_FILES;
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

  private buildFilePath(input: PassChatTempExportInput): string {
    const hash = crypto
      .createHash("sha256")
      .update(`${input.sessionId}\n${input.title}\n${input.markdown}`)
      .digest("hex")
      .slice(0, 12);
    return path.join(this.baseDir, `pass-chat_${hash}.md`);
  }

  private async ensurePrivateBaseDir(): Promise<void> {
    await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await this.chmodDirectoryOwnerOnly(this.baseDir);
  }

  private async chmodDirectoryOwnerOnly(dirPath: string): Promise<void> {
    try {
      await fs.chmod(dirPath, 0o700);
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

  private async cleanupIfNeeded(): Promise<void> {
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
}
