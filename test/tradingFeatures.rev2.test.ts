import assert from "node:assert/strict";
import {describe, it} from "node:test";
import {MemoryStore} from "../src/core/store.js";
import {createServer} from "../src/server.js";
import {createScheduler} from "../src/core/scheduler.js";
import {calculateFeatures, FEATURE_VERSION_V2, FEATURE_INDEX_KEY_V2, featureKey, REV2_METRICS,
  type FeatureInput, type FeatureSnapshot, type Metric} from "../src/query/tradingFeatures.js";
import {etToUtc, sessionAt, SESSION_CLOCK} from "../src/query/sessionClock.js";
import {decideRegime, readEquityRegime, type RegimeLeg} from "../src/query/equityRegime.js";
import {EQUITY_REGIME_POOLS, EQUITY_REGIME_TOKENS, FEATURE_WATCHLIST_KEY, loadReferenceSessions, runTradingFeatures} from "../src/jobs/tradingFeatures.js";
import type {PoolOhlcvResult} from "../src/query/poolOhlcv.js";
import {RWA_UNIVERSE_KEY} from "../src/universe.js";

const POOL="0x0000000000000000000000000000000000000010";
const BASE="0x0000000000000000000000000000000000000001", QUOTE="0x0000000000000000000000000000000000000002";
const STEPS={"5m":300_000,"15m":900_000,"1h":3_600_000} as const;
type Interval=keyof typeof STEPS;
const SPY={underlyingTicker:"SPY",marketStatus:null,openState:true,asOf:1};
const et=(y:number,m:number,d:number,h:number,mi:number,s=0)=>etToUtc({year:y,month:m,day:d},h,mi)+s*1000;
/** `count` closed bars ending at the last closed bucket before `now`; `shape(i)` sets each bar. */
function series(now:number,interval:Interval,count:number,shape:(i:number,last:boolean)=>Partial<{open:number;high:number;low:number;close:number;volume:number|null}>=()=>({}),
  extra:Partial<FeatureInput>={}):FeatureInput{
  const step=STEPS[interval], cutoff=Math.floor((now-15_000)/step)*step;
  return {chainId:56,poolAddress:POOL,baseAddress:BASE,quoteAddress:QUOTE,priceCurrency:"token",volumeCurrency:"quote_token",
    volumeUnavailableReason:null,source:"geckoterminal",interval,observedAt:now,conflictingTimestamps:[],
    candles:Array.from({length:count},(_,i)=>({timestamp:cutoff-(count-i)*step,open:100,high:101,low:99,close:100,volume:10,...shape(i,i===count-1)})),
    ...extra};
}
const calc=(input:FeatureInput,now=input.observedAt)=>calculateFeatures(input,now,FEATURE_VERSION_V2);
function near(value:number|null|undefined,expected:number,eps=1e-9){assert.ok(value!=null&&Math.abs(value-expected)<eps,`${value} != ${expected}`);}
const m=(s:FeatureSnapshot,name:string)=>(s.metrics as Record<string,Metric>)[name]!;

describe("indicatorRevision 2 — bar-only metrics",()=>{
  it("computes Bollinger 20/2σ (population) by hand and flags a zero-width band",()=>{
    const now=Date.now();
    // Last 20 closes: ten at 90, ten at 110 → mean 100, population σ 10.
    const s=calc(series(now,"5m",60,(i)=>{const c=i<40?100:i<50?90:110;return {open:c,high:c+1,low:c-1,close:c};}));
    near(m(s,"bbMiddle20").value,100); near(m(s,"bbUpper20").value,120); near(m(s,"bbLower20").value,80);
    near(m(s,"bbPosition20").value,(110-80)/40); near(m(s,"bbWidthPct20").value,40);
    assert.equal(m(s,"bbMiddle20").requiredBars,20); assert.equal(m(s,"bbMiddle20").unit,"quote_token_per_base_token");
    assert.equal(m(s,"bbPosition20").unit,"ratio"); assert.equal(m(s,"bbWidthPct20").unit,"percent");
    const flat=calc(series(now,"5m",60));
    assert.equal(m(flat,"bbPosition20").reason,"zero_width"); assert.equal(m(flat,"bbPosition20").value,null);
    near(m(flat,"bbWidthPct20").value,0);
    assert.equal(m(calc(series(now,"5m",19)),"bbUpper20").reason,"insufficient_history");
    assert.equal(calculateFeatures(series(now,"5m",60),now).metrics.bbMiddle20,undefined);
  });
  it("needs 42 bars for StochRSI 14/14 and reuses the rev 1 RSI recurrence bar-for-bar",()=>{
    const now=Date.now();
    const rising=(i:number)=>({open:200+i,high:201+i,low:199+i,close:200+i});
    const short=calc(series(now,"5m",41,rising));
    assert.equal(m(short,"stochRsi14").reason,"insufficient_history"); assert.equal(m(short,"stochRsi14").requiredBars,42);
    // Monotonic rise: every RSI reads 100 → zero range.
    assert.equal(m(calc(series(now,"5m",42,rising)),"stochRsi14").reason,"zero_range");
    // Rise for 41 bars then one drop: RSI falls off 100 on the last observation only → StochRSI 0.
    const drop=calc(series(now,"5m",42,(i,last)=>last?{open:241,high:242,low:230,close:231}:rising(i)));
    near(m(drop,"stochRsi14").value,0); assert.equal(m(drop,"stochRsi14").available,true);
    assert.ok(m(drop,"rsi14").value!<100&&m(drop,"rsi14").value!>0);
    // Flat then a single rise on the last bar: min 50, max > 50, last is the max → 1.
    const up=calc(series(now,"5m",42,(_,last)=>last?{open:100,high:111,low:99,close:110}:{}));
    near(m(up,"stochRsi14").value,1);
  });
});

describe("indicatorRevision 2 — NYSE session clock",()=>{
  it("labels rth / close / overnight and converts boundaries across both DST switches",()=>{
    // 2026-09-18 is a Friday (EDT, UTC−4).
    assert.equal(et(2026,9,18,9,30),Date.UTC(2026,8,18,13,30));
    assert.equal(sessionAt(et(2026,9,18,15,59)).state,"rth");
    assert.equal(sessionAt(et(2026,9,18,16,0)).state,"close");
    assert.equal(sessionAt(et(2026,9,18,19,59)).state,"close");
    assert.equal(sessionAt(et(2026,9,18,20,0)).state,"overnight");
    const saturday=sessionAt(et(2026,9,19,12,0));
    assert.equal(saturday.state,"overnight");
    assert.equal(saturday.nextBoundaryAt,et(2026,9,21,9,30));
    assert.equal(saturday.lastRthCloseAt,et(2026,9,18,16,0));
    assert.equal(saturday.sessionStart,et(2026,9,18,20,0));
    const rth=sessionAt(et(2026,9,18,10,15));
    assert.equal(rth.nextBoundaryAt,et(2026,9,18,16,0)); assert.equal(rth.sessionStart,et(2026,9,18,9,30));
    assert.equal(rth.orbEnd,et(2026,9,18,10,0)); assert.equal(rth.lastRthCloseAt,et(2026,9,17,16,0));
    // DST starts Sun 2026-03-08: Friday before is EST (UTC−5), Monday after is EDT (UTC−4).
    assert.equal(et(2026,3,6,9,30),Date.UTC(2026,2,6,14,30));
    assert.equal(et(2026,3,9,9,30),Date.UTC(2026,2,9,13,30));
    assert.equal(sessionAt(Date.UTC(2026,2,9,13,29)).state,"overnight");
    assert.equal(sessionAt(Date.UTC(2026,2,9,13,30)).state,"rth");
    // DST ends Sun 2026-11-01.
    assert.equal(et(2026,10,30,16,0),Date.UTC(2026,9,30,20,0));
    assert.equal(et(2026,11,2,16,0),Date.UTC(2026,10,2,21,0));
    assert.equal(sessionAt(Date.UTC(2026,10,2,20,59)).state,"rth");
    assert.equal(sessionAt(Date.UTC(2026,10,2,21,0)).state,"close");
    assert.deepEqual(SESSION_CLOCK,{timeZone:"America/New_York",rth:"09:30-16:00",close:"16:00-20:00",holidays:"none"});
  });
});

describe("indicatorRevision 2 — session-anchored metrics",()=>{
  it("answers not_us_equity for every pool without a reference, and carries the clock in parameters",()=>{
    const s=calc(series(et(2026,9,18,10,30,30),"5m",60));
    for (const name of ["lastRthClose","gapPct","vwapSession","vwapDistancePct","orbHigh","orbLow","orbBreakPct"]) {
      assert.equal(m(s,name).reason,"not_us_equity"); assert.equal(m(s,name).value,null);
    }
    assert.deepEqual(s.session,{usEquity:false,reason:"not_us_equity",state:null,nextBoundaryAt:null,sessionStart:null,lastRthCloseAt:null,evaluatedAt:s.calculatedAt});
    assert.equal(s.parameters.indicatorRevision,2);
    assert.deepEqual(s.parameters.indicatorWarmupBars,{rsi14:29,macd:52,signal9:69,histogram:69,momentum10:11,bb20:20,stochRsi14:42,vwapSession:1,gap:1,orb:6});
    assert.deepEqual(s.parameters.sessionClock,SESSION_CLOCK);
    assert.equal(s.input.referenceSession,null);
  });
  it("gaps against the on-chain close at the last 16:00 ET, and says so when the window holds none",()=>{
    // Friday 17:00 ET, 5m bars for the last 10 hours: the bar closing at 16:00 ET has close 200, latest 210.
    const now=et(2026,9,18,17,0,30), rthClose=et(2026,9,18,16,0);
    const s=calc(series(now,"5m",120,(_,last)=>last?{close:210,high:211}:{},{referenceSession:SPY}));
    const step=300_000;
    const fixed=series(now,"5m",120,(_,last)=>last?{close:210,high:211}:{},{referenceSession:SPY});
    for (const b of fixed.candles) if (b.timestamp+step===rthClose) Object.assign(b,{open:200,close:200,high:201,low:199});
    const g=calc(fixed);
    assert.equal(s.session!.state,"close"); assert.equal(s.session!.usEquity,true);
    assert.equal(m(g,"lastRthClose").value,200); assert.equal(m(g,"lastRthClose").asOf,rthClose);
    near(m(g,"gapPct").value,5); assert.equal(m(g,"gapPct").unit,"percent");
    // Saturday noon, 10 hours of bars: nothing in the window closed inside RTH.
    const weekend=calc(series(et(2026,9,19,12,0,30),"5m",120,()=>({}),{referenceSession:SPY}));
    assert.equal(weekend.session!.state,"overnight");
    assert.equal(m(weekend,"lastRthClose").reason,"no_rth_close_in_window"); assert.equal(m(weekend,"lastRthClose").asOf,null);
    assert.equal(m(weekend,"gapPct").reason,"no_rth_close_in_window"); assert.equal(m(weekend,"gapPct").usableBars,0);
  });
  it("sums session VWAP from the session start and reuses RVOL's volume vocabulary",()=>{
    // Friday 10:30:30 ET on 5m: session bars 09:30..10:25 = 12 bars, typical price 100 except the last at 200.
    const now=et(2026,9,18,10,30,30);
    const s=calc(series(now,"5m",60,(_,last)=>last?{open:200,high:200,low:200,close:200,volume:1}:{volume:1},{referenceSession:SPY}));
    near(m(s,"vwapSession").value,(11*100+200)/12); assert.equal(m(s,"vwapSession").usableBars,12);
    near(m(s,"vwapDistancePct").value,(200/((11*100+200)/12)-1)*100);
    const unknown=calc(series(now,"5m",60,()=>({}),{referenceSession:SPY,volumeCurrency:"base_token",volumeUnavailableReason:"provider_volume_unit_unverified"}));
    assert.equal(m(unknown,"vwapSession").reason,"unknown_volume_unit"); assert.equal(m(unknown,"rvol20").reason,"unknown_volume_unit");
    const missing=calc(series(now,"5m",60,(i)=>i===55?{volume:null}:{},{referenceSession:SPY}));
    assert.equal(m(missing,"vwapSession").reason,"invalid_volume");
    const zero=calc(series(now,"5m",60,(i)=>i>=48?{volume:0}:{},{referenceSession:SPY}));
    assert.equal(m(zero,"vwapSession").reason,"zero_volume"); assert.equal(m(zero,"vwapDistancePct").reason,"zero_volume");
  });
  it("forms the opening range from the two 15m bars, refuses 1h, and waits until 10:00 ET",()=>{
    const orbStart=et(2026,9,18,9,30), now=et(2026,9,18,10,30,30);
    const shape=(bar:{timestamp:number})=>bar.timestamp===orbStart?{high:105,low:95}:bar.timestamp===orbStart+900_000?{high:107,low:93}:{};
    const fixture=series(now,"15m",40,(_,last)=>last?{close:110,high:111}:{},{referenceSession:SPY});
    for (const b of fixture.candles) Object.assign(b,shape(b));
    const s=calc(fixture);
    assert.equal(m(s,"orbHigh").value,107); assert.equal(m(s,"orbLow").value,93);
    assert.equal(m(s,"orbHigh").requiredBars,2); assert.equal(m(s,"orbHigh").usableBars,2);
    near(m(s,"orbBreakPct").value,(110-107)/107*100);
    const inside=series(now,"15m",40,()=>({}),{referenceSession:SPY});
    for (const b of inside.candles) Object.assign(b,shape(b));
    near(m(calc(inside),"orbBreakPct").value,0); assert.equal(m(calc(inside),"orbBreakPct").available,true);
    assert.equal(m(calc(series(now,"1h",40,()=>({}),{referenceSession:SPY})),"orbHigh").reason,"interval_too_coarse");
    const early=calc(series(et(2026,9,18,9,50),"15m",40,()=>({}),{referenceSession:SPY}));
    assert.equal(m(early,"orbHigh").reason,"orb_not_formed"); assert.equal(early.session!.state,"rth");
    assert.equal(m(calc(series(et(2026,9,18,17,0),"15m",40,()=>({}),{referenceSession:SPY})),"orbLow").reason,"not_rth");
  });
});

describe("indicatorRevision 2 — equity regime",()=>{
  const leg=(over:Partial<RegimeLeg>):RegimeLeg=>({pool:POOL,interval:"1h",emaSpreadPct:1,roc10Pct:1,rsi14:55,macdHistogram:0.1,gapPct:0,available:true,staleness:"fresh",reason:null,...over});
  it("decides the four cases deterministically",()=>{
    assert.equal(decideRegime(leg({}),leg({})).regime,"risk_on");
    assert.equal(decideRegime(leg({emaSpreadPct:-1,roc10Pct:-2}),leg({emaSpreadPct:-0.1,roc10Pct:-0.1})).regime,"risk_off");
    const gap=decideRegime(leg({}),leg({gapPct:-2.5}));
    assert.equal(gap.regime,"risk_off"); assert.ok(gap.reasons.some(r=>r.includes("gap")&&r.includes("qqq")));
    assert.equal(decideRegime(leg({emaSpreadPct:-1}),leg({})).regime,"neutral");
    const off=decideRegime(leg({}),leg({available:false,reason:"stale_input",emaSpreadPct:null,roc10Pct:null}));
    assert.equal(off.regime,"unavailable"); assert.deepEqual(off.reasons,["qqq: stale_input"]);
    const noGap=decideRegime(leg({gapPct:null}),leg({}));
    assert.equal(noGap.regime,"risk_on"); assert.ok(noGap.reasons[0]!.includes("gap clause not evaluated"));
  });
  it("serves /trading/regime/us-equity from the two stored 1h snapshots",async()=>{
    const store=new MemoryStore(), now=et(2026,9,18,11,0,30);
    const index={pools:[{pool:EQUITY_REGIME_POOLS.spy,currency:"token",tokenAddress:EQUITY_REGIME_TOKENS.spy,usEquity:true},
      {pool:EQUITY_REGIME_POOLS.qqq,currency:"token",tokenAddress:EQUITY_REGIME_TOKENS.qqq,usEquity:true}],intervals:["5m","15m","1h"],maxPools:10,selection:"marketplace_reference_pools"};
    await store.put(FEATURE_INDEX_KEY_V2,index,{source:"test",freshForMs:120_000,deadAfterMs:120_000});
    const app=createServer({store,scheduler:createScheduler(store)});
    const pending=await (await app.request("/trading/regime/us-equity")).json() as {data:{regime:string;spy:RegimeLeg};meta:{staleness:string}};
    assert.equal(pending.data.regime,"unavailable"); assert.equal(pending.data.spy.reason,"features_pending"); assert.equal(pending.meta.staleness,"dead");
    for (const [pool,token,direction] of [[EQUITY_REGIME_POOLS.spy,EQUITY_REGIME_TOKENS.spy,1],[EQUITY_REGIME_POOLS.qqq,EQUITY_REGIME_TOKENS.qqq,1]] as const) {
      const input=series(now,"1h",120,(i)=>{const p=500+direction*i;return {open:p,high:p+1,low:p-1,close:p};},
        {poolAddress:pool,baseAddress:token,quoteAddress:"0x55d398326f99059ff775485246999027b3197955",referenceSession:{...SPY,underlyingTicker:token===EQUITY_REGIME_TOKENS.spy?"SPY":"QQQ"}});
      const snapshot=calculateFeatures(input,now,FEATURE_VERSION_V2);
      await store.put(featureKey(pool,"1h","token",token,FEATURE_VERSION_V2),snapshot,{source:"test",freshForMs:3_600_000,deadAfterMs:3_600_000});
    }
    const regime=await readEquityRegime(store,now);
    assert.equal(regime.regime,"risk_on"); assert.equal(regime.sessionState,"rth"); assert.equal(regime.nextBoundaryAt,et(2026,9,18,16,0));
    assert.ok(regime.spy.emaSpreadPct!>0&&regime.qqq.roc10Pct!>0); assert.equal(regime.spy.pool,EQUITY_REGIME_POOLS.spy);
    assert.ok(regime.spy.gapPct!==null);
    assert.equal((await app.request("/trading/regime/us-equity?x=1")).status,400);
    const body=await (await app.request("/trading/regime/us-equity")).json() as {data:{regime:string;rule:{indicatorRevision:number}}};
    assert.ok(["risk_on","unavailable"].includes(body.data.regime)); assert.equal(body.data.rule.indicatorRevision,2);
  });
});

describe("indicatorRevision 2 — replay, regression and producer wiring",()=>{
  it("recomputes the same snapshotId after JSONB key reordering, reference session included",()=>{
    const now=et(2026,9,18,10,30,30);
    const snapshot=calc(series(now,"15m",60,()=>({}),{referenceSession:SPY}));
    function reordered(value:unknown):unknown {
      if(Array.isArray(value))return value.map(reordered);
      if(value!==null&&typeof value==="object")return Object.fromEntries(Object.entries(value).reverse().map(([key,entry])=>[key,reordered(entry)]));
      return value;
    }
    const roundTrip=reordered(JSON.parse(JSON.stringify(snapshot))) as FeatureSnapshot;
    const replay=calculateFeatures(roundTrip.input,roundTrip.calculatedAt,roundTrip.version);
    assert.equal(replay.snapshotId,snapshot.snapshotId); assert.deepEqual(replay,snapshot);
    assert.ok(REV2_METRICS.every(name=>name in snapshot.metrics));
    // The same bars without a reference are a different observation.
    assert.notEqual(calc(series(now,"15m",60)).snapshotId,snapshot.snapshotId);
  });
  it("keeps the rev 1 fields byte-identical and v1 untouched by the reference session",()=>{
    const now=Date.now();
    const data=series(now,"5m",69,(_,last)=>last?{high:111,close:110}:{});
    const rev1={momentum10:{value:10,available:true,reason:null,requiredBars:11,usableBars:11,unit:"quote_token_per_base_token"},
      rsi14:{value:100,available:true,reason:null,requiredBars:29,usableBars:29,unit:"index"},
      macd:{value:20/13-20/27,available:true,reason:null,requiredBars:52,usableBars:52,unit:"quote_token_per_base_token"},
      signal9:{value:(20/13-20/27)/5,available:true,reason:null,requiredBars:69,usableBars:69,unit:"quote_token_per_base_token"},
      histogram:{value:(20/13-20/27)*4/5,available:true,reason:null,requiredBars:69,usableBars:69,unit:"quote_token_per_base_token"}};
    const s=calc(data);
    for (const [name,expected] of Object.entries(rev1)) {
      const actual=m(s,name); near(actual.value,expected.value); assert.deepEqual({...actual,value:0},{...expected,value:0});
      assert.equal(JSON.stringify(Object.keys(actual)),JSON.stringify(Object.keys(expected)));
    }
    const withReference=calc({...data,referenceSession:SPY});
    for (const name of Object.keys(rev1)) assert.deepEqual(m(withReference,name),m(s,name));
    const v1=calculateFeatures({...data,referenceSession:SPY},now), v1bare=calculateFeatures(data,now);
    assert.deepEqual(v1,v1bare); assert.ok(!("referenceSession" in v1.input)); assert.equal(v1.session,undefined);
  });
  it("resolves the reference session from the RWA snapshot and marks usEquity on the index",async()=>{
    let clock=et(2026,9,18,10,30,30);const now=clock;const store=new MemoryStore(()=>clock);
    await store.put(RWA_UNIVERSE_KEY,{rows:[{address:EQUITY_REGIME_TOKENS.spy,platform:"bstock",underlyingTicker:"SPY",marketStatus:null,openState:true},
      {address:BASE,platform:"other",underlyingTicker:"X"}]},{source:"test",freshForMs:0,deadAfterMs:60_000});
    const references=await loadReferenceSessions(store);
    assert.equal(references.size,1); assert.equal(references.get(EQUITY_REGIME_TOKENS.spy)!.underlyingTicker,"SPY");
    await store.put(FEATURE_WATCHLIST_KEY,[{pool:EQUITY_REGIME_POOLS.spy,currency:"token",tokenAddress:EQUITY_REGIME_TOKENS.spy},{pool:POOL,currency:"token",tokenAddress:BASE}],{source:"test",freshForMs:60_000,deadAfterMs:60_000});
    const load=async(_s:unknown,p:{poolAddress:string;interval:string;tokenAddress?:string}):Promise<PoolOhlcvResult>=>{
      const data=series(now,p.interval as Interval,60,()=>({}),{poolAddress:p.poolAddress,baseAddress:p.tokenAddress!});
      return {schemaVersion:2,candles:data.candles,base:{address:p.tokenAddress!,name:null,symbol:null},quote:{address:QUOTE,name:null,symbol:null},
        poolAddress:p.poolAddress,interval:p.interval as "5m",limit:500,source:"geckoterminal",asOf:now,staleness:"fresh",priceCurrency:"token",volumeCurrency:"quote_token",volumeUnavailableReason:null};
    };
    // Two pools × three intervals = 6 series at 4 per pass: two passes, the lease released by the clock.
    await runTradingFeatures(store,AbortSignal.timeout(2000),{now:()=>clock,load:load as never});
    clock+=61_000;
    await runTradingFeatures(store,AbortSignal.timeout(2000),{now:()=>clock,load:load as never});
    const index=(await store.get<{pools:{pool:string;usEquity:boolean}[]}>(FEATURE_INDEX_KEY_V2))!.data;
    assert.deepEqual(index.pools.map(p=>p.usEquity),[true,false]);
    const spy=(await store.get<FeatureSnapshot>(featureKey(EQUITY_REGIME_POOLS.spy,"5m","token",EQUITY_REGIME_TOKENS.spy,FEATURE_VERSION_V2)))!.data;
    assert.deepEqual(spy.input.referenceSession,{underlyingTicker:"SPY",marketStatus:null,openState:true,asOf:spy.input.referenceSession!.asOf});
    assert.equal(spy.session!.state,"rth"); assert.equal(m(spy,"vwapSession").available,true);
    const other=(await store.get<FeatureSnapshot>(featureKey(POOL,"5m","token",BASE,FEATURE_VERSION_V2)))!.data;
    assert.equal(other.input.referenceSession,null); assert.equal(m(other,"gapPct").reason,"not_us_equity");
    const app=createServer({store,scheduler:createScheduler(store)});
    const pools=await (await app.request("/trading/features/v2/pools")).json() as {data:{pools:{usEquity:boolean}[]}};
    assert.deepEqual(pools.data.pools.map(p=>p.usEquity),[true,false]);
    const read=await (await app.request(`/trading/features/v2/${EQUITY_REGIME_POOLS.spy}?interval=5m`)).json() as {data:{identity:{referenceSession:{underlyingTicker:string}};session:{state:string};parameters:{indicatorRevision:number}}};
    assert.equal(read.data.identity.referenceSession.underlyingTicker,"SPY"); assert.equal(read.data.session.state,"rth"); assert.equal(read.data.parameters.indicatorRevision,2);
  });
  it("handoff §11: passes usEquity through to the OHLCV load call, false for a non-equity pool",async()=>{
    let clock=et(2026,9,18,10,30,30);const now=clock;const store=new MemoryStore(()=>clock);
    await store.put(RWA_UNIVERSE_KEY,{rows:[{address:EQUITY_REGIME_TOKENS.spy,platform:"bstock",underlyingTicker:"SPY",marketStatus:null,openState:true}]},{source:"test",freshForMs:0,deadAfterMs:60_000});
    await store.put(FEATURE_WATCHLIST_KEY,[{pool:EQUITY_REGIME_POOLS.spy,currency:"usd",tokenAddress:EQUITY_REGIME_TOKENS.spy},{pool:POOL,currency:"usd",tokenAddress:BASE}],{source:"test",freshForMs:60_000,deadAfterMs:60_000});
    const seen:Record<string,boolean>={};
    const load=async(_s:unknown,p:{poolAddress:string;interval:string;tokenAddress?:string;usEquity?:boolean}):Promise<PoolOhlcvResult>=>{
      seen[p.poolAddress]=p.usEquity??false;
      const data=series(now,p.interval as Interval,60,()=>({}),{poolAddress:p.poolAddress,baseAddress:p.tokenAddress!});
      return {schemaVersion:2,candles:data.candles,base:{address:p.tokenAddress!,name:null,symbol:null},quote:{address:QUOTE,name:null,symbol:null},
        poolAddress:p.poolAddress,interval:p.interval as "5m",limit:500,source:"geckoterminal",asOf:now,staleness:"fresh",priceCurrency:"usd",volumeCurrency:"usd",volumeUnavailableReason:null};
    };
    await runTradingFeatures(store,AbortSignal.timeout(2000),{now:()=>clock,load:load as never});
    clock+=61_000;
    await runTradingFeatures(store,AbortSignal.timeout(2000),{now:()=>clock,load:load as never});
    assert.equal(seen[EQUITY_REGIME_POOLS.spy],true);
    assert.equal(seen[POOL],false);
  });
});
