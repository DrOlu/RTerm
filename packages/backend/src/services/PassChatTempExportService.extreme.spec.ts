import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassChatTempExportService } from "./PassChatTempExportService";

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

await runCase(
  "pass-chat temp export keeps only the newest files after max count",
  async () => {
    const baseDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gyshell-pass-chat-export-"),
    );
    try {
      const service = new PassChatTempExportService({ baseDir, maxFiles: 3 });
      const oldFile = path.join(baseDir, "pass-chat_old_oldhash.md");
      await fs.writeFile(oldFile, "old", "utf8");
      const oldTime = new Date(Date.now() - 60_000);
      await fs.utimes(oldFile, oldTime, oldTime);

      for (let index = 0; index < 3; index += 1) {
        await service.exportMarkdown({
          sessionId: `session-${index}`,
          title: `Chat ${index}`,
          markdown: `# Chat ${index}\n`,
        });
      }

      const files = await fs.readdir(baseDir);
      assert.equal(files.length, 3);
      assert.ok(!files.includes("pass-chat_old_oldhash.md"));
      assert.ok(files.every((name) => name.startsWith("pass-chat_")));
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  },
);

await runCase(
  "pass-chat temp export keeps directory private and filenames opaque",
  async () => {
    const parentDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gyshell-pass-chat-export-parent-"),
    );
    const baseDir = path.join(parentDir, "exports");
    try {
      const service = new PassChatTempExportService({ baseDir, maxFiles: 50 });
      const filePath = await service.exportMarkdown({
        sessionId: "session-secret-123",
        title: "Sensitive Planning Chat",
        markdown: "# Sensitive Planning Chat\n",
      });

      const dirStat = await fs.stat(baseDir);
      const fileStat = await fs.stat(filePath);
      const fileName = path.basename(filePath);

      assert.equal(dirStat.mode & 0o777, 0o700);
      assert.equal(fileStat.mode & 0o777, 0o600);
      assert.match(fileName, /^pass-chat_[a-f0-9]{12}\.md$/);
      assert.ok(!fileName.includes("session-secret"));
      assert.ok(!fileName.includes("Sensitive"));
      assert.ok(!fileName.includes("Planning"));
    } finally {
      await fs.rm(parentDir, { recursive: true, force: true });
    }
  },
);
