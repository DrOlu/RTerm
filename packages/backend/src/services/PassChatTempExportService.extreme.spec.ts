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

await runCase(
  "pass-chat temp export can disable cleanup for durable references",
  async () => {
    const baseDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gyshell-pass-chat-export-durable-"),
    );
    try {
      const service = new PassChatTempExportService({
        baseDir,
        maxFiles: null,
      });

      for (let index = 0; index < 5; index += 1) {
        await service.exportMarkdown({
          sessionId: `session-${index}`,
          title: `Durable Chat ${index}`,
          markdown: `# Durable Chat ${index}\n${index}`,
        });
      }

      const files = await fs.readdir(baseDir);
      assert.equal(files.length, 5);
      assert.ok(files.every((name) => name.startsWith("pass-chat_")));
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  },
);

await runCase(
  "pass-chat durable grouped exports clean up by session",
  async () => {
    const baseDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gyshell-pass-chat-export-grouped-"),
    );
    try {
      const service = new PassChatTempExportService({
        baseDir,
        maxFiles: null,
        groupBySession: true,
      });
      const firstPath = await service.exportMarkdown({
        sessionId: "session-a",
        title: "A",
        markdown: "# A\none",
      });
      const secondPath = await service.exportMarkdown({
        sessionId: "session-a",
        title: "A",
        markdown: "# A\ntwo",
      });
      const otherPath = await service.exportMarkdown({
        sessionId: "session-b",
        title: "B",
        markdown: "# B\n",
      });

      assert.match(
        path.basename(firstPath),
        /^pass-chat_[a-f0-9]{12}_[a-f0-9]{12}\.md$/,
      );
      assert.ok(!path.basename(firstPath).includes("session-a"));
      assert.equal(service.readManagedMarkdownSync(firstPath), "# A\none");
      assert.equal(
        service.readManagedMarkdownForSessionSync(firstPath, "session-a"),
        "# A\none",
      );
      assert.equal(
        service.readManagedMarkdownForSessionSync(firstPath, "session-b"),
        null,
      );
      assert.equal(
        service.isManagedExportPathForSession(firstPath, "session-a"),
        true,
      );
      assert.equal(
        service.isManagedExportPathForSession(firstPath, "session-b"),
        false,
      );
      assert.equal(
        service.readManagedMarkdownSync(path.join(baseDir, "not-managed.md")),
        null,
      );

      const outsidePath = path.join(baseDir, "..", "outside.md");
      await fs.writeFile(outsidePath, "outside", "utf8");
      assert.equal(service.readManagedMarkdownSync(outsidePath), null);

      const symlinkPath = path.join(
        baseDir,
        "pass-chat_aaaaaaaaaaaa_bbbbbbbbbbbb.md",
      );
      try {
        await fs.symlink(outsidePath, symlinkPath);
        assert.equal(service.readManagedMarkdownSync(symlinkPath), null);
      } catch {
        // Some filesystems or test environments do not allow symlink creation.
      }

      service.deleteManagedExportPathForSession(firstPath, "session-b");
      assert.ok((await fs.stat(firstPath)).isFile());

      service.deleteExportsForSession("session-a");

      await assert.rejects(() => fs.stat(firstPath));
      await assert.rejects(() => fs.stat(secondPath));
      assert.ok((await fs.stat(otherPath)).isFile());
    } finally {
      await fs.rm(baseDir, { recursive: true, force: true });
    }
  },
);
