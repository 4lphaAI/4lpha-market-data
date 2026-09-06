import assert from "node:assert/strict";
import {afterEach, describe, it} from "node:test";
import {MemoryStore, PostgresStore} from "../src/core/store.js";
import {FakePg} from "./fakePg.js";
import {createServer} from "../src/server.js";
import {createScheduler} from "../src/core/scheduler.js";
import {calculateFeatures, FEATURE_VERSION_V2, FEATURE_INDEX_KEY_V2, featureKey, readFeatureAttempt, readTradingFeatures,
  type FeatureInput, type FeatureSnapshot} from "../src/query/tradingFeatures.js";
import {defaultFeatureSelection, runTradingFeatures, FEATURE_WATCHLIST_KEY} from "../src/jobs/tradingFeatures.js";
import {getPoolOhlcv, normalizeChart, poolOhlcvKey, type OhlcvAttempt, type PoolOhlcvResult} from "../src/query/poolOhlcv.js";
import {fetchDexCandles} from "../src/adapters/dexPaprika.js";

const POOL="0x0000000000000000000000000000000000000010";
const BASE="0x0000000000000000000000000000000000000001", QUOTE="0x0000000000000000000000000000000000000002";
const STEP=300_000;
const fetch=globalThis.fetch;
afterEach(()=>{globalThis.fetch=fetch;});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function input(count=120): FeatureInput {
  const now=Date.now(), end=Math.floor((now-15_000)/STEP)*STEP;
  return {chainId:56,poolAddress:POOL,baseAddress:BASE,quoteAddress:QUOTE,priceCurrency:"token",volumeCurrency:"quote_token",
    volumeUnavailableReason:null,source:"geckoterminal",interval:"5m",observedAt:now,conflictingTimestamps:[],
    candles:Array.from({length:count},(_,i)=>({timestamp:end-(count-i)*STEP,open:100,high:i===count-1?111:101,low:99,close:i===count-1?110:100,volume:10}))};
}
function chart(data=input()): PoolOhlcvResult {
  return {schemaVersion:2,candles:data.candles,base:{address:BASE,name:null,symbol:null},quote:{address:QUOTE,name:null,symbol:null},
    poolAddress:POOL,interval:"5m",limit:500,source:data.source,asOf:data.observedAt,staleness:"fresh",priceCurrency:"token",volumeCurrency:"quote_token",volumeUnavailableReason:null};
}
function near(value:number|null,expected:number){assert.ok(value!==null&&Math.abs(value-expected)<1e-10,`${value} != ${expected}`);}
async function config(store:MemoryStore|PostgresStore){await store.put(FEATURE_WATCHLIST_KEY,[{pool:POOL,currency:"token"}],{source:"test",freshForMs:60_000,deadAfterMs:60_000});}

describe("versioned feature warm-up",()=>{
  it("retains v1 and computes v2 from fixed per-indicator windows",()=>{
    const data=input(52), now=Date.now();
    assert.equal(calculateFeatures(data,now).metrics.ema26.reason,"insufficient_history");
    const v2=calculateFeatures(data,now,FEATURE_VERSION_V2);
    near(v2.metrics.ema12.value,100+20/13);near(v2.metrics.ema26.value,100+20/27);near(v2.metrics.atr14.value,19/7);
    assert.deepEqual(v2.parameters.warmupBars,{ema12:24,ema26:52,atr14:29});
    const short=calculateFeatures({...data,candles:data.candles.slice(-39)},now,FEATURE_VERSION_V2);
    assert.equal(short.metrics.ema12.available,true);assert.equal(short.metrics.atr14.available,true);
    assert.equal(short.metrics.ema26.reason,"insufficient_history");
    assert.notEqual(v2.snapshotId,calculateFeatures(data,now).snapshotId);
    const long=input(120);long.observedAt=now;
    assert.deepEqual(calculateFeatures(long,now,FEATURE_VERSION_V2).metrics,v2.metrics);
  });
  it("isolates old defects without accepting gaps inside a required window",()=>{
    const data=input();data.candles[0]!.high=0;
    assert.equal(calculateFeatures(data,Date.now()).metrics.ema12.reason,"invalid_bar");
    assert.equal(calculateFeatures(data,Date.now(),FEATURE_VERSION_V2).metrics.ema26.available,true);
    data.candles.splice(-30,1);
    const v2=calculateFeatures(data,Date.now(),FEATURE_VERSION_V2);
    assert.equal(v2.metrics.ema12.available,true);assert.equal(v2.metrics.ema26.reason,"gap");
    assert.equal(v2.metrics.atr14.available,true);
    data.candles.splice(-3,1);
    assert.equal(calculateFeatures(data,Date.now(),FEATURE_VERSION_V2).metrics.roc10Pct.reason,"gap");
  });
  it("defaults to explicit major and liquid equity references, not all LP seeds",()=>{
    const selection=defaultFeatureSelection();assert.equal(selection.length,6);
    assert.equal(new Set(selection.map(p=>p.pool)).size,6);
    assert.ok(selection.every(p=>p.currency==="token"&&p.tokenAddress));
    assert.ok(selection.some(p=>p.pool==="0x172fcd41e0913e95784454622d1c3724f546f849"));
    assert.ok(!selection.some(p=>p.pool==="0x613ebcfcf41749571d659a0bf3e2c0032fd4859e"));
  });
});

describe("quality-aware whole-series selection",()=>{
  it("preserves valid Dex OHLC when volume is missing, without inventing zero",async()=>{
    const data=input(52);
    const rows=await fetchDexCandles({poolAddress:POOL,interval:"5m",start:data.candles[0]!.timestamp/1000,end:Date.now()/1000,limit:100,
      fetchFn:async()=>json(data.candles.map(b=>({time_open:new Date(b.timestamp).toISOString(),open:b.open,high:b.high,low:b.low,close:b.close})))});
    assert.equal(rows.length,52);assert.ok(rows.every(b=>b.volume===null));
    const value=calculateFeatures({...data,source:"dexpaprika",candles:rows,volumeUnavailableReason:"provider_volume_unit_unverified"},Date.now(),FEATURE_VERSION_V2);
    assert.equal(value.metrics.ema26.available,true);assert.equal(value.metrics.atr14.available,true);
    assert.equal(value.metrics.rvol20.reason,"unknown_volume_unit");
  });
  function serve(gap:boolean,dexBroken=false){
    const data=input(120);let geckoCalls=0,dexCalls=0;
    globalThis.fetch=async request=>{
      const url=new URL(String(request));
      if(url.hostname.includes("gecko")){
        geckoCalls++;const bars=data.candles.filter((_,i)=>!gap||i!==115);
        return json({data:{attributes:{ohlcv_list:bars.map(b=>[b.timestamp/1000,b.open,b.high,b.low,b.close,b.volume])}},meta:{base:{address:BASE},quote:{address:QUOTE}}});
      }
      dexCalls++;if(dexBroken)return json({},503);
      if(!url.pathname.endsWith("ohlcv"))return json({id:POOL,chain:"bsc",base_token_id:BASE,quote_token_id:QUOTE,tokens:[]});
      const start=Number(url.searchParams.get("start"))*1000,end=Number(url.searchParams.get("end"))*1000;
      return json(data.candles.filter(b=>b.timestamp>=start&&b.timestamp<end).map(b=>({time_open:new Date(b.timestamp).toISOString(),open:200,high:202,low:198,close:200,volume:10})));
    };
    return {data,counts:()=>({geckoCalls,dexCalls})};
  }
  const params={poolAddress:POOL,interval:"5m" as const,currency:"token" as const,limit:500,qualityPolicy:"trading-v2" as const};
  it("tries Dex for a fresh but gapped Gecko response and never splices prices",async()=>{
    const stub=serve(true);const attempts:OhlcvAttempt[]=[];const store=new MemoryStore();
    const result=await getPoolOhlcv(store,{...params,onAttempt:a=>attempts.push(a)});
    assert.equal(result!.source,"dexpaprika");assert.ok(result!.candles.every(b=>b.close===200));
    assert.equal(result!.candles[0]!.volume,null);assert.equal(attempts[0]!.reason,"gap");
    assert.equal(attempts.at(-1)!.reason,"ready");assert.equal(stub.counts().dexCalls,3);
    await getPoolOhlcv(store,{...params,limit:10});assert.equal(stub.counts().dexCalls,3);
    assert.equal(await store.get(poolOhlcvKey(POOL,"5m",500,"token")),null);
  });
  it("reuses sufficient chart history without another fetch",async()=>{
    const data=input(), store=new MemoryStore();
    await store.put(poolOhlcvKey(POOL,"5m",500,"token"),chart(data),{source:"geckoterminal",freshForMs:60_000,deadAfterMs:60_000});
    globalThis.fetch=async()=>{assert.fail("cache must be reused");};
    assert.equal((await getPoolOhlcv(store,params))!.source,"geckoterminal");
  });
  it("tries the alternative even when the cached chart is fresh but gapped",async()=>{
    const stub=serve(true), store=new MemoryStore();
    const cached=chart(stub.data);cached.candles=cached.candles.filter((_,i)=>i!==115);
    await store.put(poolOhlcvKey(POOL,"5m",500,"token"),cached,{source:"geckoterminal",freshForMs:60_000,deadAfterMs:60_000});
    assert.equal((await getPoolOhlcv(store,params))!.source,"dexpaprika");
  });
  it("retains partial real history and diagnostic evidence when the alternative fails",async()=>{
    serve(true,true);const attempts:OhlcvAttempt[]=[];
    const result=await getPoolOhlcv(new MemoryStore(),{...params,onAttempt:a=>attempts.push(a)});
    assert.equal(result!.source,"geckoterminal");assert.equal(result!.candles.length,119);
    assert.equal(attempts.at(-1)!.reason,"provider_error");
  });
  it("does not trade away complete cached price coverage for a newer gapped series",async()=>{
    const stub=serve(true,true);const store=new MemoryStore();
    const pair={base:{address:BASE,name:null,symbol:null},quote:{address:QUOTE,name:null,symbol:null}};
    const cached=normalizeChart(stub.data.candles.map(b=>({...b,volume:10})),pair,"token","dexpaprika",0,Date.now(),STEP);
    await store.put(poolOhlcvKey(POOL,"5m",500,"token",undefined,"trading-v2"),cached,{source:"dexpaprika",freshForMs:0,deadAfterMs:60_000});
    const before=(await store.get(poolOhlcvKey(POOL,"5m",500,"token",undefined,"trading-v2")))!.asOf;
    const result=await getPoolOhlcv(store,params);assert.equal(result!.source,"dexpaprika");assert.equal(result!.asOf,before);
  });
});

describe("producer diagnostics and v2 API",()=>{
  it("persists failure reasons/backoff through Postgres and distinguishes unavailable from queued",async()=>{
    let now=Date.now();const store=await PostgresStore.create("unused",{client:new FakePg(),now:()=>now});await config(store);
    const load:typeof getPoolOhlcv=async(_store,p)=>{p.onAttempt?.({source:"geckoterminal",reason:"rate_limited"});p.onAttempt?.({source:"dexpaprika",reason:"invalid_candles"});return null;};
    for(let i=0;i<2;i++){
      await assert.rejects(runTradingFeatures(store,AbortSignal.timeout(1000),{now:()=>now,load}),/every attempted/);
      if(i===0)now+=61_000;
    }
    const attempt=await readFeatureAttempt(store,POOL,"5m","token",undefined,now);
    assert.equal(attempt.state,"unavailable");assert.equal(attempt.reason,"invalid_candles");
    assert.equal(attempt.nextAttempt,now+120_000);assert.equal(attempt.sources!.length,2);
    const app=createServer({store,scheduler:createScheduler(store)});
    const response=await app.request(`/trading/features/v2/${POOL}?interval=5m`);
    const body=await response.json() as {error:{code:string;reason:string};meta:{producer:{consecutiveFailures:number}}};
    assert.equal(body.error.code,"features_unavailable");assert.equal(body.error.reason,"invalid_candles");
    assert.equal(body.meta.producer.consecutiveFailures,2);
    await store.close();
  });
  it("publishes both versions from one load and replays the explicit v2 seed",async()=>{
    const store=new MemoryStore();await config(store);let calls=0;
    await runTradingFeatures(store,AbortSignal.timeout(1000),{load:async()=>{calls++;return chart(input(52));}});
    assert.equal(calls,3);assert.ok(await store.get(FEATURE_INDEX_KEY_V2));
    const old=await readTradingFeatures(store,POOL,"5m",Date.now(),"token");
    const current=await readTradingFeatures(store,POOL,"5m",Date.now(),"token",undefined,FEATURE_VERSION_V2);
    assert.equal(old!.metrics["ema26"]!.available,false);assert.equal(current!.metrics["ema26"]!.available,true);
    const snapshot=(await store.get<FeatureSnapshot>(featureKey(POOL,"5m","token",undefined,FEATURE_VERSION_V2)))!.data;
    assert.deepEqual(calculateFeatures(snapshot.input,snapshot.calculatedAt,snapshot.version),snapshot);
    const app=createServer({store,scheduler:createScheduler(store)});
    const response=await app.request(`/trading/features/v2/${POOL}/input?snapshotId=${snapshot.snapshotId}`);assert.equal(response.status,200);
    const index=await (await app.request("/trading/features/v2/pools")).json() as {data:{series:unknown[]}};assert.equal(index.data.series.length,3);
    const batch=await (await app.request(`/trading/features/v2?pools=${POOL},${BASE}`)).json() as {data:Record<string,{data?:{version:string};error?:{code:string}}>};
    assert.equal(batch.data[POOL]!.data!.version,FEATURE_VERSION_V2);assert.equal(batch.data[BASE]!.error!.code,"outside_feature_watchlist");
  });
});
