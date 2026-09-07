import { lookup } from "node:dns/promises";
import { BlockList, isIPv4 } from "node:net";
import { request } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { safeUrl } from "./config.js";

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0",8], ["10.0.0.0",8], ["100.64.0.0",10], ["127.0.0.0",8],
  ["169.254.0.0",16], ["172.16.0.0",12], ["192.0.0.0",24], ["192.0.2.0",24],
  ["192.88.99.0",24], ["192.168.0.0",16], ["198.18.0.0",15], ["198.51.100.0",24],
  ["203.0.113.0",24], ["224.0.0.0",4], ["240.0.0.0",4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
export function publicIPv4(ip: string): boolean { return isIPv4(ip) && !blocked.check(ip, "ipv4"); }
export interface Reply { status: number; body: unknown; session: string | undefined }
export type GetJson = (url: string, signal: AbortSignal) => Promise<Reply>;
export type PostJson = (url: string, body: unknown, signal: AbortSignal, session?: string, protocol?: string) => Promise<Reply>;
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("studio_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
/** Connect to the checked numeric address, with the original TLS name: no second DNS lookup. */
export interface HttpIO {
  resolve: (host: string) => Promise<readonly { address: string }[]>;
  connect: (options: RequestOptions, listener: (res: IncomingMessage) => void) => ClientRequest;
}
const defaultIO: HttpIO = { resolve: host => lookup(host, { all: true, family: 4 }), connect: request };
function makeJson(io: HttpIO, method: "GET" | "POST"): PostJson { return async (value, body, parent, session, protocol) => {
  const url = new URL(safeUrl(value));
  const signal = AbortSignal.any([parent, AbortSignal.timeout(5000)]);
  const payload = method === "GET" ? "" : JSON.stringify(body);
  if (Buffer.byteLength(payload) > 65536) throw new Error("studio_request_invalid");
  if (session !== undefined && !/^[\x21-\x7e]{1,128}$/u.test(session)) throw new Error("studio_protocol_invalid");
  try {
    const answers = await abortable(io.resolve(url.hostname), signal);
    signal.throwIfAborted();
    if (!answers.length || answers.some(a => !publicIPv4(a.address))) throw new Error("studio_egress_denied");
    const address = answers[0]!.address;
    return await new Promise<Reply>((resolve, reject) => {
      const req = io.connect({ hostname: address, servername: url.hostname, port: 443,
        method, path: url.pathname, signal, agent: false,
        headers: method === "GET" ? { host: url.host, accept: "application/json" } : { host: url.host, "content-type": "application/json", accept: "application/json, text/event-stream",
          "content-length": Buffer.byteLength(payload), ...(session ? { "mcp-session-id": session } : {}),
          ...(protocol ? { "MCP-Protocol-Version": protocol } : {}) },
      }, res => {
        const status = res.statusCode ?? 0;
        if (!(method === "GET" ? [200] : [200,202,204]).includes(status)) { res.destroy(); reject(new Error("studio_upstream_failed")); return; }
        const chunks: Buffer[] = []; let bytes = 0;
        res.on("error", () => reject(new Error("studio_upstream_failed")));
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 262144) { res.destroy(); req.destroy(); reject(new Error("studio_response_large")); }
          else chunks.push(chunk);
        });
        res.on("end", () => {
          try {
            signal.throwIfAborted();
            if (bytes && res.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") throw new Error("studio_protocol_invalid");
            const token = method === "GET" ? undefined : res.headers["mcp-session-id"];
            if (token !== undefined && (typeof token !== "string" || !/^[\x21-\x7e]{1,128}$/u.test(token))) throw new Error("studio_protocol_invalid");
            const parsed: unknown = bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
            resolve({ status, body: parsed, session: token });
          } catch { reject(new Error("studio_protocol_invalid")); }
        });
      });
      req.on("error", () => reject(new Error("studio_upstream_failed")));
      if (method === "GET") req.end(); else req.end(payload);
    });
  } catch { throw new Error(signal.aborted ? "studio_timeout" : "studio_upstream_failed"); }
}; }
export function makePostJson(io: HttpIO = defaultIO): PostJson { return makeJson(io, "POST"); }
export function makeGetJson(io: HttpIO = defaultIO): GetJson {
  const send = makeJson(io, "GET");
  return (url, signal) => send(url, undefined, signal);
}
export const postJson = makePostJson();
export const getJson = makeGetJson();
