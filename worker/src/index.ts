const SHANGHAI_TIME_ZONE = "Asia/Shanghai";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const MAX_REQUEST_BYTES = 1024;
const SITE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RETENTION_DAYS = 2;

const dateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

interface VisitRequestBody {
  siteId?: unknown;
  visitorId?: unknown;
}

interface CountRow {
  today: number;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (request.method === "OPTIONS") {
        return handlePreflight(request);
      }

      if (request.method === "POST" && url.pathname === "/v1/visit") {
        return await handleVisit(request, env);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({
        event: "request_failed",
        method: request.method,
        path: url.pathname,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      const origin = request.headers.get("Origin");
      const response = jsonResponse({ error: "Internal server error" }, 500);
      return origin && siteIdFromOrigin(origin) ? withCors(response, origin) : response;
    }
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const cutoffDate = addDays(shanghaiDate(new Date()), -(RETENTION_DAYS - 1));

    try {
      const result = await env.DB.prepare(
        "DELETE FROM daily_visitors WHERE visit_date < ?1",
      ).bind(cutoffDate).run();

      console.log(JSON.stringify({
        event: "retention_cleanup",
        cutoffDate,
        deletedRows: result.meta.changes,
      }));
    } catch (error) {
      console.error(JSON.stringify({
        event: "retention_cleanup_failed",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }));
      throw error;
    }
  },
} satisfies ExportedHandler<Env>;

async function handleVisit(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  if (!origin || !siteIdFromOrigin(origin)) {
    return jsonResponse({ error: "Origin required" }, 400);
  }

  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return withCors(jsonResponse({ error: "Content-Type must be application/json" }, 415), origin);
  }

  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return withCors(jsonResponse({ error: "Request body too large" }, 413), origin);
  }

  const bodyText = await readLimitedText(request, MAX_REQUEST_BYTES);
  if (bodyText === null) {
    return withCors(jsonResponse({ error: "Request body too large" }, 413), origin);
  }

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return withCors(jsonResponse({ error: "Invalid JSON" }, 400), origin);
  }
  if (!isVisitRequestBody(body)) {
    return withCors(jsonResponse({ error: "Invalid request body" }, 400), origin);
  }

  const siteId = resolveSiteId(body.siteId, origin);
  if (!siteId || !SITE_ID_PATTERN.test(siteId)) {
    return withCors(jsonResponse({ error: "Invalid siteId" }, 400), origin);
  }

  if (typeof body.visitorId !== "string" || !UUID_PATTERN.test(body.visitorId)) {
    return withCors(jsonResponse({ error: "Invalid visitorId" }, 400), origin);
  }

  if (env.VISITOR_HMAC_SECRET.length < 32) {
    throw new Error("VISITOR_HMAC_SECRET must contain at least 32 characters");
  }

  const visitDate = shanghaiDate(new Date());
  const visitorKey = await visitorDigest(
    env.VISITOR_HMAC_SECRET,
    siteId,
    visitDate,
    body.visitorId,
  );
  const timestamp = Math.floor(Date.now() / 1000);

  await env.DB.prepare(
    `INSERT OR IGNORE INTO daily_visitors
      (site_id, visit_date, visitor_key, created_at)
     VALUES (?1, ?2, ?3, ?4)`,
  ).bind(siteId, visitDate, visitorKey, timestamp).run();

  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS today
       FROM daily_visitors
      WHERE site_id = ?1 AND visit_date = ?2`,
  ).bind(siteId, visitDate).first<CountRow>();

  return withCors(jsonResponse({
    type: "visit",
    siteId,
    today: Number(row?.today ?? 0),
    date: visitDate,
    timestamp,
  }), origin);
}

function isVisitRequestBody(value: unknown): value is VisitRequestBody {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveSiteId(value: unknown, origin: string): string | null {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) {
    return siteIdFromOrigin(origin);
  }
  if (typeof value !== "string") {
    return null;
  }
  const siteId = value.trim().toLowerCase();
  return siteId || null;
}

function siteIdFromOrigin(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

async function readLimitedText(request: Request, limit: number): Promise<string | null> {
  if (!request.body) {
    return "";
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let bodyText = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      totalBytes += value.byteLength;
      if (totalBytes > limit) {
        try {
          await reader.cancel();
        } catch {
          // The body is already being discarded; the size rejection is what matters.
        }
        return null;
      }

      bodyText += decoder.decode(value, { stream: true });
    }

    bodyText += decoder.decode();
    return bodyText;
  } finally {
    reader.releaseLock();
  }
}

function handlePreflight(request: Request): Response {
  const origin = request.headers.get("Origin");
  if (!origin || !siteIdFromOrigin(origin)) {
    return jsonResponse({ error: "Origin required" }, 400);
  }

  const requestedMethod = request.headers.get("Access-Control-Request-Method");
  if (requestedMethod !== "POST") {
    return withCors(jsonResponse({ error: "Method not allowed" }, 405), origin);
  }

  return withCors(new Response(null, { status: 204 }), origin);
}

export function shanghaiDate(date: Date): string {
  const parts = dateFormatter.formatToParts(date);
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

async function visitorDigest(
  secret: string,
  siteId: string,
  visitDate: string,
  visitorId: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${siteId}\0${visitDate}\0${visitorId.toLowerCase()}`),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": JSON_CONTENT_TYPE,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", origin);
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}
