import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  await env.DB.prepare("DROP TABLE IF EXISTS daily_visitors").run();
});

describe("D1 schema initialization", () => {
  it("creates the table and index before the first visit", async () => {
    const before = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_visitors'",
    ).first<{ name: string }>();
    expect(before).toBeNull();

    const response = await SELF.fetch("https://worker.test/v1/visit", {
      method: "POST",
      headers: {
        Origin: "https://first-visit.example",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ visitorId: crypto.randomUUID() }),
    });

    expect(response.status).toBe(200);

    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'daily_visitors'",
    ).first<{ name: string }>();
    const index = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_daily_visitors_date'",
    ).first<{ name: string }>();

    expect(table?.name).toBe("daily_visitors");
    expect(index?.name).toBe("idx_daily_visitors_date");
  });
});
