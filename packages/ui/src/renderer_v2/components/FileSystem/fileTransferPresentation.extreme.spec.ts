import type { FileTransferTaskSnapshot } from "../../lib/ipcTypes";
import {
  TRANSFER_TERMINAL_DISPLAY_MS,
  buildFileSystemTransferPanelModel,
  compareStableFileTransferTasks,
  doesFileTransferRelateToTerminal,
  isFileTransferTerminalStatus,
} from "./fileTransferPresentation";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertOrder = (
  actual: FileTransferTaskSnapshot[],
  expectedIds: string[],
  message: string,
): void => {
  assertEqual(
    JSON.stringify(actual.map((task) => task.id)),
    JSON.stringify(expectedIds),
    message,
  );
};

const runCase = (name: string, fn: () => void): void => {
  fn();
  console.log(`PASS ${name}`);
};

const buildTask = (
  overrides: Partial<FileTransferTaskSnapshot> & { id: string },
): FileTransferTaskSnapshot => ({
  id: overrides.id,
  origin: overrides.origin || "user",
  mode: overrides.mode || "copy",
  sourceTerminalId: overrides.sourceTerminalId || "source-tab",
  sourceTerminalName: overrides.sourceTerminalName || "Source",
  sourceMachineIdentity: overrides.sourceMachineIdentity ?? "local://source",
  sourcePaths: overrides.sourcePaths || [`/src/${overrides.id}.bin`],
  targetTerminalId: overrides.targetTerminalId || "target-tab",
  targetTerminalName: overrides.targetTerminalName || "Target",
  targetMachineIdentity: overrides.targetMachineIdentity ?? "ssh://target",
  targetDirPath: overrides.targetDirPath || "/target",
  itemNames: overrides.itemNames || [`${overrides.id}.bin`],
  conflictStrategy: overrides.conflictStrategy || "rename",
  status: overrides.status || "queued",
  bytesDone: Number.isFinite(overrides.bytesDone)
    ? Number(overrides.bytesDone)
    : 0,
  totalBytes: Number.isFinite(overrides.totalBytes)
    ? Number(overrides.totalBytes)
    : 100,
  transferredFiles: Number.isFinite(overrides.transferredFiles)
    ? Number(overrides.transferredFiles)
    : 0,
  totalFiles: Number.isFinite(overrides.totalFiles)
    ? Number(overrides.totalFiles)
    : 1,
  percent: Number.isFinite(overrides.percent) ? Number(overrides.percent) : 0,
  message: overrides.message ?? null,
  errorMessage: overrides.errorMessage ?? null,
  cancelRequested: overrides.cancelRequested === true,
  createdAt: Number.isFinite(overrides.createdAt)
    ? Number(overrides.createdAt)
    : 1,
  updatedAt: Number.isFinite(overrides.updatedAt)
    ? Number(overrides.updatedAt)
    : 1,
  ...(overrides.startedAt !== undefined
    ? { startedAt: overrides.startedAt }
    : {}),
  ...(overrides.completedAt !== undefined
    ? { completedAt: overrides.completedAt }
    : {}),
  ...(overrides.sessionId ? { sessionId: overrides.sessionId } : {}),
  ...(overrides.agentRunId ? { agentRunId: overrides.agentRunId } : {}),
  ...(overrides.toolMessageId
    ? { toolMessageId: overrides.toolMessageId }
    : {}),
});

runCase("terminal status detection only marks final states", () => {
  assertEqual(
    isFileTransferTerminalStatus("queued"),
    false,
    "queued is active",
  );
  assertEqual(
    isFileTransferTerminalStatus("running"),
    false,
    "running is active",
  );
  assertEqual(
    isFileTransferTerminalStatus("success"),
    true,
    "success is terminal",
  );
  assertEqual(isFileTransferTerminalStatus("error"), true, "error is terminal");
  assertEqual(
    isFileTransferTerminalStatus("cancelled"),
    true,
    "cancelled is terminal",
  );
});

runCase("terminal relation checks both source and target tabs", () => {
  const task = buildTask({
    id: "transfer-a",
    sourceTerminalId: "source-a",
    targetTerminalId: "target-a",
  });
  assertEqual(
    doesFileTransferRelateToTerminal(task, "source-a"),
    true,
    "source terminal should relate",
  );
  assertEqual(
    doesFileTransferRelateToTerminal(task, "target-a"),
    true,
    "target terminal should relate",
  );
  assertEqual(
    doesFileTransferRelateToTerminal(task, "other"),
    false,
    "unrelated terminal should not relate",
  );
});

runCase("stable comparator ignores progress updatedAt churn", () => {
  const first = buildTask({
    id: "first",
    createdAt: 10,
    updatedAt: 500,
    status: "running",
    percent: 80,
  });
  const second = buildTask({
    id: "second",
    createdAt: 11,
    updatedAt: 1000,
    status: "running",
    percent: 20,
  });
  assertOrder(
    [second, first].sort(compareStableFileTransferTasks),
    ["first", "second"],
    "created order should remain stable even when later task updated more recently",
  );
});

runCase(
  "current tab transfers do not reorder when running tasks alternate updates",
  () => {
    const tasks = [
      buildTask({
        id: "u1",
        createdAt: 1,
        updatedAt: 100,
        status: "running",
        percent: 25,
      }),
      buildTask({
        id: "u2",
        createdAt: 2,
        updatedAt: 200,
        status: "running",
        percent: 25,
      }),
      buildTask({ id: "u3", createdAt: 3, updatedAt: 3, status: "queued" }),
      buildTask({ id: "u4", createdAt: 4, updatedAt: 4, status: "queued" }),
    ];
    const firstModel = buildFileSystemTransferPanelModel(
      tasks,
      "target-tab",
      300,
    );
    assertEqual(
      firstModel.sections.length,
      1,
      "all user tasks should be in one current section",
    );
    assertEqual(
      firstModel.sections[0].kind,
      "current",
      "current section should be first",
    );
    assertOrder(
      firstModel.sections[0].tasks,
      ["u1", "u2", "u3", "u4"],
      "initial visible order should follow task creation",
    );

    const secondModel = buildFileSystemTransferPanelModel(
      [
        { ...tasks[0], updatedAt: 700, percent: 50 },
        { ...tasks[1], updatedAt: 900, percent: 75 },
        tasks[2],
        tasks[3],
      ],
      "target-tab",
      1000,
    );
    assertOrder(
      secondModel.sections[0].tasks,
      ["u1", "u2", "u3", "u4"],
      "alternating progress updates must not move rows",
    );
    assertEqual(
      secondModel.counts.running,
      2,
      "running count should include two active copies",
    );
    assertEqual(
      secondModel.counts.queued,
      2,
      "queued count should include waiting copies",
    );
  },
);

runCase(
  "agent transfers outside the active tab are isolated as background work",
  () => {
    const model = buildFileSystemTransferPanelModel(
      [
        buildTask({
          id: "user-current",
          origin: "user",
          createdAt: 1,
          status: "running",
        }),
        buildTask({
          id: "agent-other",
          origin: "agent",
          createdAt: 2,
          status: "running",
          sourceTerminalId: "agent-source",
          targetTerminalId: "agent-target",
        }),
        buildTask({
          id: "user-other",
          origin: "user",
          createdAt: 3,
          status: "running",
          sourceTerminalId: "other-source",
          targetTerminalId: "other-target",
        }),
      ],
      "target-tab",
      500,
    );

    assertEqual(
      model.sections.length,
      2,
      "current and background sections should both render",
    );
    assertEqual(
      model.sections[0].kind,
      "current",
      "current tab work should stay first",
    );
    assertEqual(
      model.sections[1].kind,
      "background",
      "agent work outside this tab should be background",
    );
    assertOrder(
      model.sections[0].tasks,
      ["user-current"],
      "current section should only contain related user work",
    );
    assertOrder(
      model.sections[1].tasks,
      ["agent-other"],
      "background section should only contain agent work",
    );
    assertEqual(
      model.counts.background,
      1,
      "background count should ignore unrelated user work",
    );
  },
);

runCase("recent terminal tasks are retained briefly and then hidden", () => {
  const recentUser = buildTask({
    id: "recent-user",
    status: "success",
    createdAt: 1,
    updatedAt: 1000,
    completedAt: 1000,
  });
  const recentAgent = buildTask({
    id: "recent-agent",
    origin: "agent",
    status: "error",
    createdAt: 2,
    updatedAt: 1000,
    completedAt: 1000,
    sourceTerminalId: "agent-source",
    targetTerminalId: "agent-target",
  });

  const retained = buildFileSystemTransferPanelModel(
    [recentUser, recentAgent],
    "target-tab",
    1000 + TRANSFER_TERMINAL_DISPLAY_MS,
  );
  assertEqual(
    retained.sections.length,
    1,
    "recent terminal work should render while retained",
  );
  assertEqual(
    retained.sections[0].kind,
    "recent",
    "terminal work should move into recent section",
  );
  assertOrder(
    retained.sections[0].tasks,
    ["recent-user", "recent-agent"],
    "recent section should stay creation ordered",
  );
  assertEqual(
    retained.counts.recent,
    2,
    "recent count should include retained user and agent terminal tasks",
  );

  const expired = buildFileSystemTransferPanelModel(
    [recentUser, recentAgent],
    "target-tab",
    1001 + TRANSFER_TERMINAL_DISPLAY_MS,
  );
  assertEqual(
    expired.sections.length,
    0,
    "expired terminal tasks should disappear from the panel",
  );
});
