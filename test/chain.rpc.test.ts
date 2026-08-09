import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readRpcUrls, withBscClient } from "../src/chain/rpc.js";
import { AdapterError } from "../src/adapters/http.js";

const ENV_KEYS = ["BSC_RPC_URL", "BSC_RPC_URL1", "BSC_RPC_URL2", "BSC_RPC_URL3"];
const saved = new Map<string, string | undefined>();

for (const key of ENV_KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

describe("readRpcUrls", () => {
  it("falls back to keyless public endpoints when nothing is configured", () => {
    clearEnv();
    const urls = readRpcUrls();
    assert.ok(urls.length >= 3);
    for (const url of urls) assert.match(url, /^https:\/\//u);
  });

  it("puts configured endpoints ahead of the public ones, in order", () => {
    clearEnv();
    process.env["BSC_RPC_URL"] = "https://primary.invalid";
    process.env["BSC_RPC_URL2"] = "https://secondary.invalid";

    const urls = readRpcUrls();
    assert.equal(urls[0], "https://primary.invalid");
    assert.equal(urls[1], "https://secondary.invalid");
    assert.ok(urls.length > 2);
  });

  it("drops blanks and deduplicates", () => {
    clearEnv();
    process.env["BSC_RPC_URL"] = "   ";
    process.env["BSC_RPC_URL1"] = "https://same.invalid";
    process.env["BSC_RPC_URL2"] = "https://same.invalid";

    const urls = readRpcUrls();
    assert.equal(urls.filter((url) => url === "https://same.invalid").length, 1);
    assert.equal(urls[0], "https://same.invalid");
  });
});

describe("withBscClient", () => {
  it("uses the first endpoint that answers", async () => {
    const seen: string[] = [];
    const result = await withBscClient(
      async (client) => {
        seen.push(client.transport.url ?? "");
        return 42;
      },
      { rpcUrls: ["https://first.invalid", "https://second.invalid"] },
    );
    assert.equal(result, 42);
    assert.deepEqual(seen, ["https://first.invalid"]);
  });

  it("replays the whole read set against the next endpoint on failure", async () => {
    const seen: string[] = [];
    const result = await withBscClient(
      async (client) => {
        const url = client.transport.url ?? "";
        seen.push(url);
        if (url.includes("first")) throw new Error("eth_call is not supported");
        return "ok";
      },
      { rpcUrls: ["https://first.invalid", "https://second.invalid"] },
    );
    assert.equal(result, "ok");
    assert.deepEqual(seen, ["https://first.invalid", "https://second.invalid"]);
  });

  it("fails with a sanitized error once every endpoint is exhausted", async () => {
    await assert.rejects(
      () =>
        withBscClient(
          async () => {
            throw new Error("connect ECONNREFUSED via https://node.invalid/secret-key-value");
          },
          { rpcUrls: ["https://a.invalid", "https://b.invalid"] },
        ),
      (error: unknown) => {
        assert.ok(error instanceof AdapterError);
        assert.match(error.message, /all rpc endpoints failed/u);
        assert.ok(!error.message.includes("node.invalid"));
        return true;
      },
    );
  });

  it("stops rotating once the caller aborts", async () => {
    const controller = new AbortController();
    let attempts = 0;

    await assert.rejects(
      () =>
        withBscClient(
          async () => {
            attempts += 1;
            controller.abort();
            throw new Error("timed out");
          },
          { rpcUrls: ["https://a.invalid", "https://b.invalid", "https://c.invalid"], signal: controller.signal },
        ),
      /all rpc endpoints failed/u,
    );

    // Burning the remaining endpoints after the deadline would defeat the timeout.
    assert.equal(attempts, 1);
  });

  it("rejects immediately when no endpoint is available", async () => {
    await assert.rejects(
      () => withBscClient(async () => "unreachable", { rpcUrls: [] }),
      /no rpc endpoint configured/u,
    );
  });

  it("threads the caller's signal into the transport", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null | undefined;

    await withBscClient(
      async (client) => {
        // viem keeps the transport config, including the fetch options we set.
        const options = client.transport as { fetchOptions?: { signal?: AbortSignal } };
        seen = options.fetchOptions?.signal;
        return null;
      },
      { rpcUrls: ["https://a.invalid"], signal: controller.signal },
    );

    assert.ok(seen instanceof AbortSignal);
    assert.equal(seen.aborted, false);
    controller.abort();
    assert.equal(seen.aborted, true);
  });
});
