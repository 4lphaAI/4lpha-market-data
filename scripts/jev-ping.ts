/**
 * JEV-TEXT-FEATURES: one live TypeSafe request carrying the recorder's three real questions (Score relevance, Noul about, Choice tone) through the
 * adapter and its strict parsers, run once by the operator before MEME_JEV_ENABLED is turned on. Reads TYPESAFE_API_KEY from the environment and
 * never prints it. Pass = all three answers parse.
 *   node --import tsx --env-file=D:/4lpha-execution/.env scripts/jev-ping.ts
 */
import { askJev, parseChoiceAnswer, parseNoulAnswer, parseScoreAnswer, scrubKey } from "../src/adapters/typesafe.js";
import { JEV_ABOUT_QUESTIONS, JEV_STOCK_QUESTIONS, JEV_TONE_QUESTIONS, JEV_TONES } from "../src/jobs/memeMeasure.js";

const apiKey = process.env["TYPESAFE_API_KEY"]?.trim() ?? "";
if (apiKey === "") { console.error("TYPESAFE_API_KEY is not set"); process.exit(1); }
const levels = (JEV_STOCK_QUESTIONS["relevance"]!.criteria as readonly string[]).length;
// Made-up inputs in the recorder's own state shapes; one request per question group, as the recorder sends them.
const checks = [
  { name: "relevance (score)", state: { meme: { symbol: "CHIPDOG", name: "Chip Dog" }, stock: { symbol: "XYZB", company: "Example Semiconductors Inc" } },
    questions: JEV_STOCK_QUESTIONS, parse: (a: unknown) => parseScoreAnswer(a, levels), id: "relevance" },
  { name: "about (noul)", state: { topic: { name: "Chip Dog community launch", type: "meme", tags: ["bsc", "launch"] }, token: { symbol: "CHIPDOG" } },
    questions: JEV_ABOUT_QUESTIONS, parse: (a: unknown) => parseNoulAnswer(a), id: "about" },
  { name: "tone (choice)", state: { topic: { name: "Chip Dog community launch", type: "meme", tags: ["bsc", "launch"] } },
    questions: JEV_TONE_QUESTIONS, parse: (a: unknown) => parseChoiceAnswer(a, JEV_TONES), id: "tone" },
];
let ok = true;
for (const check of checks) {
  try {
    const response = await askJev({ apiKey, state: check.state, questions: check.questions });
    const parsed = check.parse(response.answers[check.id]);
    console.log(`${check.name}: model ${response.model}, ${parsed === null ? "DOES NOT PARSE" : "parses"}: ${JSON.stringify(parsed ?? response.answers[check.id])}`);
    if (parsed === null) ok = false;
  } catch (error) {
    ok = false;
    console.log(`${check.name}: request failed: ${scrubKey(error, apiKey)}`);
  }
}
console.log(ok ? "PASS: all three answers parse; MEME_JEV_ENABLED may be turned on." : "FAIL: keep MEME_JEV_ENABLED off and report this output.");
process.exit(ok ? 0 : 1);
