/** Shared offline fixtures. Not a test file: the runner only globs `*.test.ts`. */

import type { FetchFn } from "../src/adapters/http.js";

/** Builds a JSON `Response` the way the real upstreams do. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Builds a non-JSON `Response`, for parser-tolerance tests. */
export function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

export interface FakeCall {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

export interface FakeFetch {
  fetch: FetchFn;
  calls: FakeCall[];
}

/** Wraps a handler as an injectable `fetch`, recording every call it receives. */
export function fakeFetch(
  handler: (call: FakeCall) => Response | Promise<Response>,
): FakeFetch {
  const calls: FakeCall[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    for (const [key, value] of new Headers(init?.headers ?? {})) headers[key] = value;
    const call: FakeCall = {
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
      headers,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchFn, calls };
}

/** A fetch that always rejects, used for error-sanitization tests. */
export function throwingFetch(error: unknown): FetchFn {
  return async () => {
    throw error;
  };
}
