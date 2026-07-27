/**
 * dashboardHttpAuth — shared auth check for the /dashboard HTTP routes, used by
 * BOTH the gybackend runtime and the Electron main runtime (v3.0.3: previously
 * duplicated; a drift between the two is exactly what caused the desktop app's
 * "Upgrade Required" bug). Pure + injectable (token verifier passed in).
 *
 * Mirrors the WS gateway's connection auth: loopback is open; remote callers
 * must present a valid access token (Authorization: Bearer, x-access-token
 * header, or ?access_token= query param).
 */

export interface DashboardHttpRequestLike {
  url?: string;
  headers: Record<string, unknown>;
  socket?: { remoteAddress?: string };
}

export type VerifyTokenFn = (token: string) => Promise<boolean> | boolean;

export function isLoopbackAddress(raw: string): boolean {
  return (
    /^(127\.|::1|::ffff:127\.)/.test(raw) || raw === "" || raw === "localhost"
  );
}

export function extractDashboardToken(req: DashboardHttpRequestLike): string {
  const authz =
    typeof req.headers.authorization === "string"
      ? req.headers.authorization
      : "";
  const bearer = /^Bearer\s+(.+)$/i.exec(authz)?.[1]?.trim();
  const headerTok =
    typeof req.headers["x-access-token"] === "string"
      ? String(req.headers["x-access-token"]).trim()
      : "";
  let queryTok = "";
  try {
    queryTok =
      new URL(req.url ?? "/", "http://localhost").searchParams
        .get("access_token")
        ?.trim() ?? "";
  } catch {
    /* ignore malformed url */
  }
  return bearer || headerTok || queryTok;
}

export async function dashboardHttpAuthorized(
  req: DashboardHttpRequestLike,
  verifyToken: VerifyTokenFn,
): Promise<boolean> {
  if (isLoopbackAddress(String(req.socket?.remoteAddress ?? ""))) return true;
  const token = extractDashboardToken(req);
  if (!token) return false;
  try {
    return await verifyToken(token);
  } catch {
    return false;
  }
}
