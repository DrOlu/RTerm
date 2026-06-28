import { GatewayService } from "./GatewayService";
import type { StartTaskInput, StartTaskMode } from "./types";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

class FakeAgentRuntime {
  onRun:
    | ((
        context: unknown,
        input: StartTaskInput,
        signal: AbortSignal,
        startMode: StartTaskMode,
      ) => Promise<void> | void)
    | null = null;

  setEventPublisher(): void {}

  setFeedbackWaiter(): void {}

  setQueuedInsertionProvider(): void {}

  setQueuedInsertionAcknowledger(): void {}

  setQueuedInsertionAvailabilityWaiter(): void {}

  setQueuedInsertionEnqueuer(): void {}

  setBackgroundExecCommandRegistrar(): void {}

  setBackgroundExecCommandCompleter(): void {}

  setUnfinishedBackgroundExecCommandProvider(): void {}

  async run(
    context: unknown,
    input: StartTaskInput,
    signal: AbortSignal,
    startMode: StartTaskMode = "normal",
  ): Promise<void> {
    await this.onRun?.(context, input, signal, startMode);
  }

  isAbortError(error: unknown): boolean {
    return error instanceof Error && error.name === "AbortError";
  }

  releaseSessionModelBinding(): void {}

  listStoredChatSessions(): any[] {
    return [];
  }

  listStoredChatSessionSummaries(): any[] {
    return [];
  }

  loadChatSession(): null {
    return null;
  }

  deleteChatSession(): void {}

  deleteChatSessions(): void {}

  renameChatSession(): void {}

  exportChatSession(): null {
    return null;
  }

  rollbackToMessage(): { ok: boolean; removedCount: number } {
    return { ok: false, removedCount: 0 };
  }

  branchFromMessage(): { ok: boolean } {
    return { ok: false };
  }
}

class FakeUIHistoryService {
  recordEvent(): any[] {
    return [];
  }

  flush(): void {}

  getAllSessionSummaries(): any[] {
    return [];
  }

  getSession(): null {
    return null;
  }
}

const createGateway = (): {
  gateway: GatewayService;
  agent: FakeAgentRuntime;
} => {
  const agent = new FakeAgentRuntime();
  const gateway = new GatewayService(
    {
      setRawEventPublisher: () => {},
      getAllTerminals: () => [],
    } as any,
    agent as any,
    new FakeUIHistoryService() as any,
    {
      setFeedbackWaiter: () => {},
    } as any,
    {
      getSettings: () =>
        ({
          models: {
            activeProfileId: "profile-1",
          },
        }) as any,
    } as any,
    {
      on: () => ({}),
    } as any,
  );
  return { gateway, agent };
};

const run = async (): Promise<void> => {
  await runCase("run-state listener tracks dispatch completion", async () => {
    const { gateway, agent } = createGateway();
    const activeCounts: number[] = [];

    gateway.onRunStateChanged((snapshot) => {
      activeCounts.push(snapshot.activeCount);
    });

    agent.onRun = async () => {};
    await gateway.dispatchTask("session-1", "hello");

    assertEqual(
      activeCounts.join(","),
      "0,1,0",
      "listener should see idle, running, idle",
    );
  });

  await runCase("run-state listener tracks manual stop", async () => {
    const { gateway, agent } = createGateway();
    const activeCounts: number[] = [];

    gateway.onRunStateChanged((snapshot) => {
      activeCounts.push(snapshot.activeCount);
    });
    agent.onRun = async (_context, _input, signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const error = new Error("AbortError");
            error.name = "AbortError";
            reject(error);
          },
          { once: true },
        );
      });
    };

    const task = gateway.dispatchTask("session-1", "hello");
    await Promise.resolve();
    await gateway.stopTask("session-1");
    await task;

    assertEqual(
      activeCounts.join(","),
      "0,1,0",
      "manual stop should release the active run state",
    );
  });
};

run()
  .then(() => {
    console.log("All Gateway run-state extreme tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
