import type { FileTransferTaskSnapshot } from "../../lib/ipcTypes";

export const TRANSFER_TERMINAL_DISPLAY_MS = 7000;

export const FILE_TRANSFER_TERMINAL_STATUSES = new Set<
  FileTransferTaskSnapshot["status"]
>(["success", "error", "cancelled"]);

export type FileTransferPanelSectionKind = "current" | "background" | "recent";

export interface FileTransferPanelSection {
  kind: FileTransferPanelSectionKind;
  tasks: FileTransferTaskSnapshot[];
}

export interface FileTransferPanelCounts {
  running: number;
  scanning: number;
  queued: number;
  background: number;
  recent: number;
  total: number;
}

export interface FileSystemTransferPanelModel {
  sections: FileTransferPanelSection[];
  counts: FileTransferPanelCounts;
}

export const isFileTransferTerminalStatus = (
  status: FileTransferTaskSnapshot["status"],
): boolean => FILE_TRANSFER_TERMINAL_STATUSES.has(status);

export const doesFileTransferRelateToTerminal = (
  task: FileTransferTaskSnapshot,
  terminalId: string | null,
): boolean => {
  if (!terminalId) return false;
  return (
    task.targetTerminalId === terminalId || task.sourceTerminalId === terminalId
  );
};

const compareStableText = (left: string, right: string): number =>
  left.localeCompare(right, undefined, { numeric: true, sensitivity: "base" });

export const compareStableFileTransferTasks = (
  left: FileTransferTaskSnapshot,
  right: FileTransferTaskSnapshot,
): number => {
  const leftCreatedAt = Number(left.createdAt) || 0;
  const rightCreatedAt = Number(right.createdAt) || 0;
  if (leftCreatedAt !== rightCreatedAt) {
    return leftCreatedAt - rightCreatedAt;
  }
  return compareStableText(left.id, right.id);
};

const shouldRetainTerminalTransfer = (
  task: FileTransferTaskSnapshot,
  now: number,
): boolean => {
  const updatedAt = Number(task.updatedAt) || 0;
  return now - updatedAt <= TRANSFER_TERMINAL_DISPLAY_MS;
};

const sortStable = (
  tasks: FileTransferTaskSnapshot[],
): FileTransferTaskSnapshot[] =>
  tasks.slice().sort(compareStableFileTransferTasks);

const appendSection = (
  sections: FileTransferPanelSection[],
  kind: FileTransferPanelSectionKind,
  tasks: FileTransferTaskSnapshot[],
): void => {
  if (tasks.length <= 0) return;
  sections.push({
    kind,
    tasks: sortStable(tasks),
  });
};

export const buildFileSystemTransferPanelModel = (
  tasks: FileTransferTaskSnapshot[],
  activeTerminalId: string | null,
  now: number,
): FileSystemTransferPanelModel => {
  const current: FileTransferTaskSnapshot[] = [];
  const background: FileTransferTaskSnapshot[] = [];
  const recent: FileTransferTaskSnapshot[] = [];

  tasks.forEach((task) => {
    const isTerminal = isFileTransferTerminalStatus(task.status);
    const relatesToActiveTab = doesFileTransferRelateToTerminal(
      task,
      activeTerminalId,
    );

    if (isTerminal) {
      if (
        shouldRetainTerminalTransfer(task, now) &&
        (relatesToActiveTab || task.origin === "agent")
      ) {
        recent.push(task);
      }
      return;
    }

    if (relatesToActiveTab) {
      current.push(task);
      return;
    }

    if (task.origin === "agent") {
      background.push(task);
    }
  });

  const sections: FileTransferPanelSection[] = [];
  appendSection(sections, "current", current);
  appendSection(sections, "background", background);
  appendSection(sections, "recent", recent);

  const visibleTasks = sections.flatMap((section) => section.tasks);
  return {
    sections,
    counts: {
      running: visibleTasks.filter((task) => task.status === "running").length,
      scanning: visibleTasks.filter((task) => task.status === "scanning")
        .length,
      queued: visibleTasks.filter((task) => task.status === "queued").length,
      background: background.length,
      recent: recent.length,
      total: visibleTasks.length,
    },
  };
};
