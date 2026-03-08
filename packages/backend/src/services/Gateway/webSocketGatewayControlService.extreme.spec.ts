import {
  WebSocketGatewayControlService,
  resolveWsGatewayPolicyFromEnv,
} from "./WebSocketGatewayControlService";

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

const run = async (): Promise<void> => {
  await runCase(
    "resolveWsGatewayPolicyFromEnv preserves custom filters with host override",
    () => {
      const policy = resolveWsGatewayPolicyFromEnv({
        env: { GYSHELL_WS_HOST: "0.0.0.0" },
        defaultPolicy: {
          access: "custom",
          port: 17888,
          allowedCidrs: ["192.168.1.0/24"],
        },
        hostVarName: "GYSHELL_WS_HOST",
        portVarName: "GYSHELL_WS_PORT",
        enableVarName: "GYSHELL_WS_ENABLE",
      });

      assertEqual(
        policy.access,
        "custom",
        "host override should preserve custom access mode",
      );
      assertEqual(
        policy.hostOverride,
        "0.0.0.0",
        "host override should remain in effect",
      );
      assertDeepEqual(
        policy.allowedCidrs,
        ["192.168.1.0/24"],
        "custom CIDRs should survive env resolution",
      );
    },
  );

  await runCase(
    "resolveWsGatewayPolicyFromEnv preserves lan access with host override",
    () => {
      const policy = resolveWsGatewayPolicyFromEnv({
        env: { GYSHELL_WS_HOST: "192.168.1.8" },
        defaultPolicy: {
          access: "lan",
          port: 17888,
        },
        hostVarName: "GYSHELL_WS_HOST",
        portVarName: "GYSHELL_WS_PORT",
        enableVarName: "GYSHELL_WS_ENABLE",
      });

      assertEqual(
        policy.access,
        "lan",
        "host override should not widen LAN mode to internet mode",
      );
      assertEqual(
        policy.hostOverride,
        "192.168.1.8",
        "host override should remain in effect",
      );
    },
  );

  await runCase(
    "applyPolicy rejects custom mode without any CIDRs",
    async () => {
      const service = new WebSocketGatewayControlService({
        createAdapter: () =>
          ({
            start: () => {},
            stop: async () => {},
          }) as any,
      });

      await assertRejects(
        async () => {
          await service.applyPolicy({
            access: "custom",
            port: 17888,
            allowedCidrs: ["   ", ""],
          });
        },
        /requires at least one allowed CIDR/i,
        "custom mode should reject empty CIDR lists",
      );
    },
  );
};

void run()
  .then(() => {
    console.log("All WebSocketGatewayControlService extreme tests passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
