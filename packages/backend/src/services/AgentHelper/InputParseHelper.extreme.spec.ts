import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { InputParseHelper } from "./InputParseHelper";
import {
  FILE_CONTENT_TAG,
  PASS_CHAT_HISTORY_TAG,
  PASS_CHAT_LOCAL_PATH_SCOPE,
} from "./prompts";
import type { ISkillRuntime } from "../runtimeContracts";
import type { TerminalService } from "../TerminalService";

function createSkillRuntime(): ISkillRuntime {
  return {
    async reload() {
      return [];
    },
    async getAll() {
      return [];
    },
    async getEnabledSkills() {
      return [];
    },
    async readSkillContentByName(name: string) {
      throw new Error(`Unexpected skill read: ${name}`);
    },
    async createSkill() {
      throw new Error("Unexpected skill create");
    },
  };
}

function createTerminalService(): TerminalService {
  return {
    getAllTerminals() {
      return [];
    },
    getRecentOutput() {
      return "";
    },
    async statFile() {
      throw new Error("Unexpected terminal file stat");
    },
    async readFile() {
      throw new Error("Unexpected terminal file read");
    },
  } as unknown as TerminalService;
}

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
  "user paste mention remains plain text and does not read temp files",
  async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gyshell-input-parse-"),
    );
    try {
      const tempFile = path.join(tempDir, "paste.txt");
      await fs.writeFile(tempFile, "cached paste body", "utf8");

      const result = await InputParseHelper.parseAndEnrich(
        `before [MENTION_USER_PASTE:#${tempFile}##preview#] after`,
        createSkillRuntime(),
        createTerminalService(),
      );

      assert.equal(
        result.displayContent,
        `before [MENTION_USER_PASTE:#${tempFile}##preview#] after`,
      );
      assert.ok(!result.enrichedContent.includes(FILE_CONTENT_TAG));
      assert.ok(!result.enrichedContent.includes("cached paste body"));
      assert.ok(result.enrichedContent.includes("[MENTION_USER_PASTE:"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);

await runCase(
  "file mention still injects small local text file content",
  async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "gyshell-input-parse-"),
    );
    try {
      const tempFile = path.join(tempDir, "note.txt");
      await fs.writeFile(tempFile, "small file body", "utf8");

      const result = await InputParseHelper.parseAndEnrich(
        `read [MENTION_FILE:#${tempFile}#]`,
        createSkillRuntime(),
        createTerminalService(),
      );

      assert.ok(
        result.enrichedContent.includes(`${FILE_CONTENT_TAG}<${tempFile}>`),
      );
      assert.ok(result.enrichedContent.includes("small file body"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  },
);

await runCase(
  "pass-chat mention injects resolver detail without raw markdown content",
  async () => {
    const result = await InputParseHelper.parseAndEnrich(
      "continue from [MENTION_PASS_CHAT:#session-1##Previous%20Chat#]",
      createSkillRuntime(),
      createTerminalService(),
      {
        passChatMentionResolver: async (references) => {
          assert.deepEqual(references, [
            { sessionId: "session-1", title: "Previous Chat" },
          ]);
          return `${PASS_CHAT_HISTORY_TAG}Markdown Export Path: /tmp/gyshell-pass-chats/pass-chat.md\nLocal Path Scope: ${PASS_CHAT_LOCAL_PATH_SCOPE}\nRecommended read_file args: tabIdOrName="local-1", filePath="/tmp/gyshell-pass-chats/pass-chat.md"\nInstruction: read the file if needed.\n\n`;
        },
      },
    );

    assert.equal(
      result.displayContent,
      "continue from [MENTION_PASS_CHAT:#session-1##Previous%20Chat#]",
    );
    assert.ok(result.enrichedContent.includes(PASS_CHAT_HISTORY_TAG));
    assert.ok(
      result.enrichedContent.includes(
        "Markdown Export Path: /tmp/gyshell-pass-chats/pass-chat.md",
      ),
    );
    assert.ok(result.enrichedContent.includes(PASS_CHAT_LOCAL_PATH_SCOPE));
    assert.ok(
      result.enrichedContent.includes(
        'Recommended read_file args: tabIdOrName="local-1"',
      ),
    );
    assert.ok(
      result.enrichedContent.includes(
        "[MENTION_PASS_CHAT:#session-1##Previous%20Chat#]",
      ),
    );
  },
);
