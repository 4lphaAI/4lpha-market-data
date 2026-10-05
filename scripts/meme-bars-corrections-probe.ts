/**
 * What does the re-read correct? Runs `meme-bars` at its real schedule against
 * live Sintral (board copied from the deployed plane) and, after every cycle,
 * prints each closed bar that changed since the previous cycle: how long after
 * its minute ended it was first served, how long after that it changed, and
 * which fields moved. Read-only. Usage: node --import tsx scripts/meme-bars-corrections-probe.ts [cycles=6]
 */
import { loadDotEnv } from "../src/config/env.js";
import { MemoryStore } from "../src/core/store.js";
import { MEME_BOARD_KEY } from "../src/jobs/memeBoard.js";
import { MEME_BARS_INDEX_KEY, memeBarsKey, msUntilNextRun, runMemeBars, type BarSeries, type BarsIndex, type StoredBar } from "../src/jobs/memeBars.js";
import { RWA_UNIVERSE_KEY } from "../src/universe.js";
loadDotEnv();

const PROD = "https://data-plane-production.up.railway.app";
const token = process.env["DP_AUTH_TOKEN"];
if (token === undefined || token === "") throw new Error("DP_AUTH_TOKEN missing");
const get = async (path: string) =>
  (await (await fetch(`${PROD}${path}`, { headers: { "x-dp-token": token } })).json()) as { data: unknown };
const cycles = Number(process.argv[2] ?? "6");
const store = new MemoryStore();
const board = async () => store.put(MEME_BOARD_KEY, (await get("/memes?status=runner,active,quiet,fading,dead,unknown&limit=800")).data, { source: "prod", freshForMs: 180_000, deadAfterMs: 1_800_000 });
await store.put(RWA_UNIVERSE_KEY, { rows: (await get("/universe?lane=bstocks")).data }, { source: "prod", freshForMs: 3_600_000, deadAfterMs: 7_200_000 });

const servedAt = new Map<string, number>(); // address|minute -> when first served
let previous = new Map<string, Map<number, StoredBar>>();
const fields = ["start", "open", "high", "low", "close", "volume", "trades", "filled"];
let total = 0;
const kinds: Record<string, number> = {};
for (let i = 0; i <= cycles; i++) {
  await board();
  await new Promise((resolve) => setTimeout(resolve, msUntilNextRun(Date.now())));
  const at = Date.now();
  const result = await runMemeBars(store, AbortSignal.timeout(45_000), { holder: "probe" });
  const index = (await store.get<BarsIndex>(MEME_BARS_INDEX_KEY))!.data;
  const current = new Map<string, Map<number, StoredBar>>();
  for (const address of Object.keys(index.tokens)) {
    const s = (await store.get<BarSeries>(memeBarsKey(address)))?.data;
    if (!s) continue;
    const bars = new Map(s.bars.map((b) => [b[0], b] as const));
    current.set(address, bars);
    for (const b of s.bars) if (!servedAt.has(`${address}|${b[0]}`)) servedAt.set(`${address}|${b[0]}`, at);
    const before = previous.get(address);
    if (!before) continue;
    for (const [minute, old] of before) {
      const now = bars.get(minute);
      if (!now || JSON.stringify(now) === JSON.stringify(old)) continue;
      total++;
      const changed = fields.filter((_, k) => now[k] !== old[k]);
      const kind = old[7] === 1 && now[7] === 0 ? "fill->traded" : changed.join("+");
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      const firstServed = servedAt.get(`${address}|${minute}`)!;
      console.log(`  ${address.slice(0, 10)} minute ${new Date(minute).toISOString().slice(11, 16)} served +${Math.round((firstServed - minute - 60_000) / 1000)}s, changed by +${Math.round((at - minute - 60_000) / 1000)}s: ${kind}  high ${old[2]}->${now[2]} (${((now[2] / old[2] - 1) * 100).toFixed(2)}%) low ${old[3]}->${now[3]} (${((now[3] / old[3] - 1) * 100).toFixed(2)}%) open ${now[1]} close ${now[4]} nextOpen ${bars.get(minute + 60_000)?.[1]}`);
    }
  }
  previous = current;
  console.log(`cycle ${i}: calls ${result.calls} corrected ${result.corrected}`);
}
console.log(`total corrections ${total}: ${JSON.stringify(kinds)}`);
