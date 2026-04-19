import { WebSocketGatewayAdapter } from "./WebSocketGatewayAdapter";

const assertEqual = <T>(actual: T, expected: T, message: string): void => {
  if (actual !== expected) {
    throw new Error(
      `${message}. expected=${String(expected)} actual=${String(actual)}`,
    );
  }
};

const assertDeepEqual = (
  actual: unknown,
  expected: unknown,
  message: string,
): void => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson !== expectedJson) {
    throw new Error(
      `${message}. expected=${expectedJson} actual=${actualJson}`,
    );
  }
};

const assertRejects = async (
  fn: () => Promise<unknown>,
  pattern: RegExp,
  message: string,
): Promise<void> => {
  try {
    await fn();
    throw new Error(`${message}: expected rejection`);
  } catch (error) {
    const actualMessage =
      error instanceof Error ? error.message : String(error);
    if (!pattern.test(actualMessage)) {
      throw new Error(
        `${message}: unexpected error message "${actualMessage}"`,
      );
    }
  }
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const createAdapter = (
  transferEntries: NonNullable<
    NonNullable<
      ConstructorParameters<typeof WebSocketGatewayAdapter>[1]["filesystemBridge"]
    >["transferEntries"]
  >,
): WebSocketGatewayAdapter =>
  new WebSocketGatewayAdapter({} as any, {
    host: "127.0.0.1",
    port: 0,
    filesystemBridge: {
      transferEntries,
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });

const executeTransferEntries = async (
  adapter: WebSocketGatewayAdapter,
  params: Record<string, unknown>,
): Promise<unknown> =>
  await (adapter as any).executeRequest(
    {
      method: "filesystem:transferEntries",
      params,
    },
    {},
  );

const run = async (): Promise<void> => {
  await runCase(
    "filesystem transfer forwards keep-both conflict strategy",
    async () => {
      let captured: unknown = null;
      const adapter = createAdapter(
        async (
          sourceTerminalId,
          sourcePaths,
          targetTerminalId,
          targetDirPath,
          options,
        ) => {
          captured = {
            sourceTerminalId,
            sourcePaths,
            targetTerminalId,
            targetDirPath,
            options,
          };
          return {
            mode: "copy",
            totalBytes: 0,
            transferredFiles: 0,
            totalFiles: 0,
          };
        },
      );

      const result = await executeTransferEntries(adapter, {
        sourceTerminalId: "source-terminal",
        sourcePaths: ["/src/report.txt"],
        targetTerminalId: "target-terminal",
        targetDirPath: "/dst",
        mode: "copy",
        transferId: "transfer-1",
        overwrite: false,
        conflictStrategy: "rename",
        chunkSize: 65536,
      });

      assertDeepEqual(
        captured,
        {
          sourceTerminalId: "source-terminal",
          sourcePaths: ["/src/report.txt"],
          targetTerminalId: "target-terminal",
          targetDirPath: "/dst",
          options: {
            mode: "copy",
            transferId: "transfer-1",
            overwrite: false,
            conflictStrategy: "rename",
            chunkSize: 65536,
          },
        },
        "websocket transfer should preserve conflictStrategy",
      );
      assertDeepEqual(
        result,
        {
          mode: "copy",
          totalBytes: 0,
          transferredFiles: 0,
          totalFiles: 0,
        },
        "websocket transfer should return bridge result",
      );
    },
  );

  await runCase(
    "filesystem transfer rejects invalid conflict strategies",
    async () => {
      let callCount = 0;
      const adapter = createAdapter(async () => {
        callCount += 1;
        return {
          mode: "copy",
          totalBytes: 0,
          transferredFiles: 0,
          totalFiles: 0,
        };
      });

      await assertRejects(
        async () => {
          await executeTransferEntries(adapter, {
            sourceTerminalId: "source-terminal",
            sourcePaths: ["/src/report.txt"],
            targetTerminalId: "target-terminal",
            targetDirPath: "/dst",
            conflictStrategy: "duplicate",
          });
        },
        /conflictStrategy must be "error", "overwrite", or "rename"/,
        "invalid conflictStrategy should be rejected",
      );
      assertEqual(callCount, 0, "invalid requests should not call the bridge");
    },
  );
};

void run()
  .then(() => {
    console.log("All WebSocketGatewayAdapter extreme tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
