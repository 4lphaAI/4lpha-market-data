import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createScheduler } from "../src/core/scheduler.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";

const TOKEN = "test-token-1234567890";
const originalToken = process.env["DP_AUTH_TOKEN"];

afterEach(() => {
  if (originalToken === undefined) delete process.env["DP_AUTH_TOKEN"];
  else process.env["DP_AUTH_TOKEN"] = originalToken;
});

function build(): ReturnType<typeof createServer> {
  const store = new MemoryStore();
  return createServer({ scheduler: createScheduler(store), store });
}

describe("x-dp-token auth", () => {
  it("rejects requests without the token when DP_AUTH_TOKEN is set", async () => {
    process.env["DP_AUTH_TOKEN"] = TOKEN;
    const app = build();

    const res = await app.request("/status");
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error?: { code?: string } };
    assert.equal(body.error?.code, "unauthorized");
  });

  it("rejects a wrong token", async () => {
    process.env["DP_AUTH_TOKEN"] = TOKEN;
    const app = build();

    const res = await app.request("/status", { headers: { "x-dp-token": "wrong" } });
    assert.equal(res.status, 401);
  });

  it("accepts the correct token", async () => {
    process.env["DP_AUTH_TOKEN"] = TOKEN;
    const app = build();

    const res = await app.request("/status", { headers: { "x-dp-token": TOKEN } });
    assert.equal(res.status, 200);
  });

  it("always leaves /health open for the platform healthcheck", async () => {
    process.env["DP_AUTH_TOKEN"] = TOKEN;
    const app = build();

    const res = await app.request("/health");
    assert.equal(res.status, 200);
  });

  it("stays open when DP_AUTH_TOKEN is unset", async () => {
    delete process.env["DP_AUTH_TOKEN"];
    const app = build();

    const res = await app.request("/status");
    assert.equal(res.status, 200);
  });
});
