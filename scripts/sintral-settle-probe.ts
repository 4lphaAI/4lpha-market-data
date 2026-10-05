/**
 * How long after a minute ends does Sintral keep changing that minute's bar?
 *
 * For the live meme stocks on the deployed board, reads each token's newest
 * Sintral rows at fixed offsets after a minute boundary and compares the
 * just-closed minute's bar with what it settles to two minutes later. Prints,
 * per offset, how many traded minutes were already final, how many were
 * present at all, and the share of their final volume already reported.
 * Read-only. Usage: node --import tsx scripts/sintral-settle-probe.ts [minutes=2] [tokens=24]
 */
import { loadDotEnv } from "../src/config/env.js";
import { fetchSintralMinuteBars, type SintralMinuteBar } from "../src/adapters/binanceWeb3.js";
loadDotEnv();

const PROD = "https://data-plane-production.up.railway.app";
const token = process.env["DP_AUTH_TOKEN"];
if (token === undefined || token === "") throw new Error("DP_AUTH_TOKEN missing");
const minutes = Number(process.argv[2] ?? "2");
const maxTokens = Number(process.argv[3] ?? "24");
const OFFSETS_S = [3, 6, 10, 15, 20, 30, 45, 60, 120];

const board = (await (await fetch(`${PROD}/memes?quote=bstock&status=runner,active&orderBy=txs5m&limit=${maxTokens}`, {
  headers: { "x-dp-token": token },
})).json()) as { data: Array<{ address: string }> };
const addresses = board.data.map((row) => row.address);
console.log(`tokens ${addresses.length}`);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
async function readAll(): Promise<Map<string, SintralMinuteBar[]>> {
  const out = new Map<string, SintralMinuteBar[]>();
  const queue = [...addresses];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let a = queue.shift(); a !== undefined; a = queue.shift()) {
      try { out.set(a, await fetchSintralMinuteBars({ address: a, limit: 5 })); } catch { /* counted as absent */ }
    }
  }));
  return out;
}

type Obs = { offset: number; bars: Map<string, SintralMinuteBar | undefined>; readMs: number };
const results: Array<{ minute: number; obs: Obs[] }> = [];
for (let k = 0; k < minutes; k++) {
  const end = Math.ceil(Date.now() / 60_000) * 60_000 + k * 0; // next boundary
  const minuteStart = end - 60_000;
  const obs: Obs[] = [];
  for (const offset of OFFSETS_S) {
    await sleep(end + offset * 1000 - Date.now());
    const t0 = Date.now();
    const all = await readAll();
    const bars = new Map<string, SintralMinuteBar | undefined>();
    for (const a of addresses) bars.set(a, all.get(a)?.find((b) => b.startMs === minuteStart));
    obs.push({ offset, bars, readMs: Date.now() - t0 });
  }
  results.push({ minute: minuteStart, obs });
}

for (const { minute, obs } of results) {
  const final = obs.at(-1)!.bars;
  const traded = addresses.filter((a) => final.get(a) !== undefined);
  console.log(`\nminute ${new Date(minute).toISOString().slice(11, 16)}: ${traded.length}/${addresses.length} tokens traded`);
  for (const o of obs) {
    let present = 0, exact = 0, vol = 0, volFinal = 0, trades = 0, tradesFinal = 0;
    for (const a of traded) {
      const f = final.get(a)!, b = o.bars.get(a);
      volFinal += f.volumeUsd; tradesFinal += f.trades ?? 0;
      if (b === undefined) continue;
      present++; vol += b.volumeUsd; trades += b.trades ?? 0;
      if (b.trades === f.trades && Math.abs(b.volumeUsd - f.volumeUsd) < 1e-9 && b.close === f.close) exact++;
    }
    console.log(`  +${String(o.offset).padStart(3)}s present ${present}/${traded.length} final ${exact}/${traded.length} volume ${(100 * vol / Math.max(1e-9, volFinal)).toFixed(1)}% trades ${(100 * trades / Math.max(1, tradesFinal)).toFixed(1)}% (read ${o.readMs} ms)`);
  }
}
