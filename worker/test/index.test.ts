import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { shanghaiDate } from "../src/index";

beforeAll(async () => {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS daily_visitors (
      site_id TEXT NOT NULL,
      visit_date TEXT NOT NULL,
      visitor_key TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (site_id, visit_date, visitor_key)
    ) WITHOUT ROWID
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_daily_visitors_date
      ON daily_visitors (visit_date)
  `).run();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM daily_visitors").run();
});

describe("daily visit Worker", () => {
  it("deduplicates the same visitor on the same site and day", async () => {
    const visitorId = crypto.randomUUID();
    const first = await postVisit("example-site", visitorId);
    const second = await postVisit("example-site", visitorId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json<{ today: number }>();
    const secondBody = await second.json<{ today: number }>();
    expect(firstBody.today).toBeGreaterThanOrEqual(1);
    expect(secondBody.today).toBe(firstBody.today);
  });

  it("counts different visitor identifiers", async () => {
    const first = await postVisit("example-site", crypto.randomUUID());
    const second = await postVisit("example-site", crypto.randomUUID());
    const firstBody = await first.json<{ today: number }>();
    const secondBody = await second.json<{ today: number }>();
    expect(secondBody.today).toBe(firstBody.today + 1);
  });

  it("accepts any valid website origin", async () => {
    const response = await SELF.fetch("https://worker.test/v1/visit", {
      method: "POST",
      headers: {
        Origin: "https://another.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ visitorId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ siteId: string }>();
    expect(body.siteId).toBe("another.example");
  });

  it("derives the siteId from Origin when omitted", async () => {
    const response = await postVisit(undefined, crypto.randomUUID());
    expect(response.status).toBe(200);
    const body = await response.json<{ siteId: string }>();
    expect(body.siteId).toBe("localhost");
  });

  it("accepts an explicit siteId as a partition override", async () => {
    const response = await postVisit("blog.example.com", crypto.randomUUID());
    expect(response.status).toBe(200);
    const body = await response.json<{ siteId: string }>();
    expect(body.siteId).toBe("blog.example.com");
  });

  it("rejects malformed visitor identifiers", async () => {
    const response = await postVisit("example-site", "not-a-uuid");
    expect(response.status).toBe(400);
  });

  it("rejects non-object JSON with a client error", async () => {
    const response = await SELF.fetch("https://worker.test/v1/visit", {
      method: "POST",
      headers: {
        Origin: "http://localhost:8787",
        "Content-Type": "application/json",
      },
      body: "null",
    });

    expect(response.status).toBe(400);
  });

  it("does not store the raw visitor identifier", async () => {
    const visitorId = crypto.randomUUID();
    await postVisit("example-site", visitorId);
    const rows = await env.DB.prepare(
      "SELECT visitor_key FROM daily_visitors WHERE site_id = ?1 ORDER BY created_at DESC LIMIT 10",
    ).bind("example-site").all<{ visitor_key: string }>();

    expect(rows.results.some((row) => row.visitor_key === visitorId)).toBe(false);
    expect(rows.results.every((row) => /^[0-9a-f]{64}$/.test(row.visitor_key))).toBe(true);
  });

  it("rejects request bodies larger than one KiB", async () => {
    const response = await SELF.fetch("https://worker.test/v1/visit", {
      method: "POST",
      headers: {
        Origin: "http://localhost:8787",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        siteId: "example-site",
        visitorId: crypto.randomUUID(),
        padding: "x".repeat(2048),
      }),
    });

    expect(response.status).toBe(413);
  });

  it("switches the visit date at Shanghai midnight", () => {
    expect(shanghaiDate(new Date("2026-09-21T15:59:59.000Z"))).toBe("2026-09-21");
    expect(shanghaiDate(new Date("2026-09-21T16:00:00.000Z"))).toBe("2026-09-22");
  });

  it("answers CORS preflight requests from any valid website origin", async () => {
    const response = await SELF.fetch("https://worker.test/v1/visit", {
      method: "OPTIONS",
      headers: {
        Origin: "https://another.example",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://another.example");
    expect(response.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});

function postVisit(siteId: string | undefined, visitorId: string): Promise<Response> {
  return SELF.fetch("https://worker.test/v1/visit", {
    method: "POST",
    headers: {
      Origin: "http://localhost:8787",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(siteId ? { siteId, visitorId } : { visitorId }),
  });
}
