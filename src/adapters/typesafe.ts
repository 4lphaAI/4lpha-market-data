/**
 * TypeSafe System One (model Jev): one POST, strict answer parsers.
 *
 * Contract from TypeSafe's API reference (docs.typesafe.ai/api.md, read
 * 2026-10-07): `POST /v1/systemone` with `Authorization: Bearer <key>` and
 * `{ model, state, questions: { <id>: { type, instructions, criteria } } }`;
 * the response is `{ model, answers: { <id>: Answer }, usage }`, where `model`
 * is the versioned id that answered (`jev-1.13.0` on that date). Question ids
 * are not sent to the model.
 *
 * Measurement only (JEV-TEXT-FEATURES-HANDOFF-2026-10-07): the meme-measure
 * recorder is the one caller. A parser returns `null` for anything that is not
 * exactly the answer asked for, so a malformed answer is never cached.
 */

import { AdapterError, fetchJson, isRecord, sanitizeMessage, type FetchFn } from "./http.js";

const SOURCE = "typesafe";
const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
export const JEV_MODEL = "jev-latest";

export interface JevQuestion {
  type: "score" | "noul" | "choice";
  instructions: string;
  /** Score: ordered level descriptions. Noul: `{true, false}`. Choice: option to description. */
  criteria: readonly string[] | Record<string, string>;
}

export interface JevResponse {
  /** The versioned model that answered. */
  model: string;
  answers: Record<string, unknown>;
}

export interface AskJevParams {
  apiKey: string;
  state: unknown;
  questions: Record<string, JevQuestion>;
  fetchFn?: FetchFn | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * A failure's message with the key removed by value, then sanitized: the
 * scrub runs before `sanitizeMessage` truncates, so no part of the key survives.
 */
export function scrubKey(value: unknown, apiKey: string): string {
  const raw = value instanceof Error ? value.message : typeof value === "string" ? value : "";
  return sanitizeMessage(apiKey === "" ? raw : raw.split(apiKey).join("[redacted]"));
}

/**
 * One request. Throws {@link AdapterError} on a failed request or an envelope
 * without `model`/`answers` (status 200 for the latter: the response arrived
 * but is unreadable).
 */
export async function askJev(params: AskJevParams): Promise<JevResponse> {
  const fetchFn = params.fetchFn ?? globalThis.fetch;
  const payload = await fetchJson({
    source: SOURCE,
    url: TYPESAFE_URL,
    // A transport error is scrubbed of the key before `fetchJson` sanitizes and truncates it.
    fetchFn: async (input, init) => {
      try {
        return await fetchFn(input, init);
      } catch (error) {
        throw new Error(scrubKey(error, params.apiKey));
      }
    },
    signal: params.signal,
    method: "POST",
    headers: { authorization: `Bearer ${params.apiKey}` },
    body: JSON.stringify({ model: JEV_MODEL, state: params.state, questions: params.questions }),
  });
  if (!isRecord(payload) || typeof payload["model"] !== "string" || payload["model"].trim() === "" || !isRecord(payload["answers"])) {
    throw new AdapterError(SOURCE, "unexpected response shape", 200);
  }
  return { model: payload["model"], answers: payload["answers"] };
}

export interface JevScore { type: "score"; score: number; probabilities: Record<string, number> }
export interface JevNoul { type: "noul"; noul: number }
export interface JevChoice<T extends string> { type: "choice"; choice: T; probabilities: Record<T, number> }

const isUnit = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

/**
 * Exactly `keys`, each a probability, summing to 1 within 0.02: TypeSafe
 * rounds to two decimals, so three-way answers like 0.33/0.33/0.33 or
 * 0.34/0.34/0.33 sum 0.01 off and must pass.
 */
function parseDistribution<K extends string>(value: unknown, keys: readonly K[]): Record<K, number> | null {
  if (!isRecord(value) || Object.keys(value).length !== keys.length) return null;
  const out = {} as Record<K, number>;
  let sum = 0;
  for (const key of keys) {
    const p = value[key];
    if (!isUnit(p)) return null;
    out[key] = p;
    sum += p;
  }
  return Math.abs(sum - 1) <= 0.02 ? out : null;
}

/** A Score over `levels` ordered levels: `score` within `[0, levels - 1]`, probabilities keyed `"0"`..`"levels-1"`. */
export function parseScoreAnswer(value: unknown, levels: number): JevScore | null {
  if (!isRecord(value) || value["type"] !== "score") return null;
  const score = value["score"];
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > levels - 1) return null;
  const probabilities = parseDistribution(value["probabilities"], Array.from({ length: levels }, (_, i) => String(i)));
  return probabilities === null ? null : { type: "score", score, probabilities };
}

export function parseNoulAnswer(value: unknown): JevNoul | null {
  if (!isRecord(value) || value["type"] !== "noul" || !isUnit(value["noul"])) return null;
  return { type: "noul", noul: value["noul"] };
}

/** A Choice among exactly `options`, with a probability for each. */
export function parseChoiceAnswer<T extends string>(value: unknown, options: readonly T[]): JevChoice<T> | null {
  if (!isRecord(value) || value["type"] !== "choice") return null;
  const choice = value["choice"];
  if (typeof choice !== "string" || !(options as readonly string[]).includes(choice)) return null;
  const probabilities = parseDistribution(value["probabilities"], options);
  return probabilities === null ? null : { type: "choice", choice: choice as T, probabilities };
}
