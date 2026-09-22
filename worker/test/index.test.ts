import { env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { shanghaiDate } from "../src/index";

beforeAll(async () => {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS daily_pageviews (
      site_id TEXT NOT NULL,
      visit_date TEXT NOT NULL,
      pv INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (site_id, visit_date)
    ) WITHOUT ROWID
  `).run();
  await env.DB.prepare(`
    CREATE INDEX IF NOT EXISTS idx_daily_pageviews_date
      ON daily_pageviews (visit_date)
  `).run();
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM daily_pageviews").run();
});

describe("daily view Worker", () => {
  it("counts every request without deduplication", async () => {
    const first = await postView("example-site");
    const second = await postView("example-site");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json<{ pv: number }>();
    const secondBody = await second.json<{ pv: number }>();
    expect(firstBody.pv).toBe(1);
    expect(secondBody.pv).toBe(2);
  });

  it("keeps view counters separate for different sites", async () => {
    const first = await postView("site-a");
    const other = await postView("site-b");
    const second = await postView("site-a");

    expect((await first.json<{ pv: number }>()).pv).toBe(1);
    expect((await other.json<{ pv: number }>()).pv).toBe(1);
    expect((await second.json<{ pv: number }>()).pv).toBe(2);
  });

  it("accepts any valid website origin", async () => {
    const response = await SELF.fetch("https://worker.test/v1/visit", {
      method: "POST",
      headers: {
        Origin: "https://another.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(200);
    const body = await response.json<{ siteId: string; pv: number }>();
    expect(body.siteId).toBe("another.example");
    expect(body.pv).toBe(1);
  });

  it("derives the siteId from Origin when omitted", async () => {
    const response = await postView(undefined);
    expect(response.status).toBe(200);
    const body = await response.json<{ siteId: string }>();
    expect(body.siteId).toBe("localhost");
  });

  it("accepts an explicit siteId as a partition override", async () => {
    const response = await postView("blog.example.com");
    expect(response.status).toBe(200);
    const body = await response.json<{ siteId: string }>();
    expect(body.siteId).toBe("blog.example.com");
  });

  it("accepts an explicit siteId without an Origin header", async () => {
    const response = await SELF.fetch("https://worker.test/v1/visit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ siteId: "server-to-server.example" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json<{ siteId: string; pv: number }>();
    expect(body.siteId).toBe("server-to-server.example");
    expect(body.pv).toBe(1);
  });

  it("rejects an omitted siteId when Origin cannot derive one", async () => {
    const response = await SELF.fetch("https://worker.test/v1/visit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(400);
  });

  it("returns the current view count without incrementing it", async () => {
    await postView("example-site");
    await postView("example-site");

    const first = await getViewCount("example-site");
    const second = await getViewCount("example-site");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((await first.json<{ pv: number }>()).pv).toBe(2);
    expect((await second.json<{ pv: number }>()).pv).toBe(2);
  });

  it("rejects malformed site identifiers", async () => {
    const response = await postView("not a site id");
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

  it("rejects request bodies larger than one KiB", async () => {
    const response = await SELF.fetch("https://worker.test/v1/visit", {
      method: "POST",
      headers: {
        Origin: "http://localhost:8787",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        siteId: "example-site",
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

function postView(siteId: string | undefined): Promise<Response> {
  return SELF.fetch("https://worker.test/v1/visit", {
    method: "POST",
    headers: {
      Origin: "http://localhost:8787",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(siteId ? { siteId } : {}),
  });
}

function getViewCount(siteId: string | undefined): Promise<Response> {
  const url = new URL("https://worker.test/v1/visit");
  if (siteId) {
    url.searchParams.set("siteId", siteId);
  }
  return SELF.fetch(url, {
    headers: {
      Origin: "http://localhost:8787",
    },
  });
}
