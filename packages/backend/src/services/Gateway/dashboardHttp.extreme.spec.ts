import http from "node:http";
import { WebSocketGatewayAdapter } from "./WebSocketGatewayAdapter";
import type { IGatewayRuntime } from "./types";

/**
 * dashboardHttp.extreme.spec — live /dashboard HTTP endpoint on the same port
 * as the WS gateway: HTML page, JSON state, 404s, and WS still functional.
 * Run: npx tsx --test packages/backend/src/services/Gateway/dashboardHttp.extreme.spec.ts
 */

const assert = (cond: unknown, message: string): void => {
  if (!cond) throw new Error(`assert failed: ${message}`);
};

const runCase = async (
  name: string,
  fn: () => Promise<void> | void,
): Promise<void> => {
  await fn();
  console.log(`PASS ${name}`);
};

const fakeGateway = {
  registerTransport: () => {},
  unregisterTransport: () => {},
} as unknown as IGatewayRuntime;

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

interface StartedAdapter {
  adapter: WebSocketGatewayAdapter;
  port: number;
}

const startAdapter = async (
  httpRoutes: ConstructorParameters<typeof WebSocketGatewayAdapter>[1]["httpRoutes"],
): Promise<StartedAdapter> => {
  const adapter = new WebSocketGatewayAdapter(fakeGateway, {
    host: "127.0.0.1",
    port: 0, // ephemeral
    httpRoutes,
    logger: silentLogger,
  });
  adapter.start();
  // Wait until the listener is actually bound (the facade exposes address()).
  const deadline = Date.now() + 8000;
  let port = 0;
  for (;;) {
    const srv = (adapter as unknown as { server?: { address?: () => { port?: number } | null } }).server;
    const p = srv?.address?.()?.port;
    if (typeof p === "number" && p > 0) {
      port = p;
      break;
    }
    if (Date.now() > deadline) throw new Error("adapter did not bind in time");
    await new Promise((r) => setTimeout(r, 50));
  }
  return { adapter, port };
};

const httpGet = (
  port: number,
  path: string,
): Promise<{ status: number; body: string; contentType: string }> =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET" },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            contentType: String(res.headers["content-type"] ?? ""),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });

// ── cases ──────────────────────────────────────────────────────────────────

await runCase("httpRoutes: /dashboard serves HTML on the WS port", async () => {
  const { adapter, port } = await startAdapter([
    {
      path: "/dashboard",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!DOCTYPE html><title>dash</title>ok");
      },
    },
  ]);
  try {
    const r = await httpGet(port, "/dashboard");
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.contentType.includes("text/html"), `html content-type, got ${r.contentType}`);
    assert(r.body.includes("<title>dash</title>"), "html body served");
  } finally {
    await adapter.stop();
  }
});

await runCase("httpRoutes: unknown path returns 404", async () => {
  const { adapter, port } = await startAdapter([
    {
      path: "/dashboard",
      handler: (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
    },
  ]);
  try {
    const r = await httpGet(port, "/nope");
    assert(r.status === 404, `expected 404, got ${r.status}`);
  } finally {
    await adapter.stop();
  }
});

await runCase("httpRoutes: /dashboard/json returns JSON state", async () => {
  const { adapter, port } = await startAdapter([
    {
      path: "/dashboard/json",
      handler: (_req, res) => {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ hosts: [], slos: [], at: 123 }));
      },
    },
  ]);
  try {
    const r = await httpGet(port, "/dashboard/json");
    assert(r.status === 200, `expected 200, got ${r.status}`);
    assert(r.contentType.includes("application/json"), `json content-type, got ${r.contentType}`);
    const parsed = JSON.parse(r.body) as { at?: number };
    assert(parsed.at === 123, "json body parsed");
  } finally {
    await adapter.stop();
  }
});

await runCase("httpRoutes: handler error becomes 500", async () => {
  const { adapter, port } = await startAdapter([
    {
      path: "/boom",
      handler: () => {
        throw new Error("kaboom");
      },
    },
  ]);
  try {
    const r = await httpGet(port, "/boom");
    assert(r.status === 500, `expected 500, got ${r.status}`);
    assert(r.body.includes("kaboom"), "error message in body");
  } finally {
    await adapter.stop();
  }
});

await runCase("httpRoutes: WS RPC still works on the same port", async () => {
  const { adapter, port } = await startAdapter([
    {
      path: "/dashboard",
      handler: (_req, res) => {
        res.writeHead(200);
        res.end("ok");
      },
    },
  ]);
  try {
    const WsClient = (await import("ws")).default as unknown as new (url: string) => {
      on(event: "open", listener: () => void): void;
      on(event: "message", listener: (raw: Buffer) => void): void;
      on(event: "error", listener: (err: Error) => void): void;
      send(data: string): void;
      close(): void;
    };
    const ws = new WsClient(`ws://127.0.0.1:${port}`);
    const pong = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("ws timeout")), 5000);
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "gateway:rpc", id: "p1", method: "gateway:ping", params: {} }));
      });
      ws.on("message", (raw: Buffer) => {
        const msg = JSON.parse(raw.toString()) as { id?: string; result?: { pong?: boolean } };
        if (msg.id === "p1") {
          clearTimeout(timer);
          resolve(String(msg.result?.pong));
        }
      });
      ws.on("error", (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    assert(pong === "true", `expected pong=true, got ${pong}`);
    ws.close();
  } finally {
    await adapter.stop();
  }
});

console.log("dashboardHttp: all cases passed");
