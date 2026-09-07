import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import { studioConfig, CATALOG_KEY } from "../src/studio/config.js";
import { makeGetJson, type Reply } from "../src/studio/http.js";
import { parseCard, probeCard } from "../src/studio/a2a.js";
import { metadata } from "../src/studio/probe.js";
import { studioJob, type Catalog, type ProbeDeps } from "../src/studio/catalog.js";
import { MemoryStore } from "../src/core/store.js";
import { createScheduler } from "../src/core/scheduler.js";
import { createServer } from "../src/server.js";

const url = "https://seller.example/.well-known/agent-card.json";
const target = { id: "7", a2aCardUrl: url };
const env = { STUDIO_DISCOVERY_ENABLED: "true", STUDIO_DISCOVERY_RPC_URL: "https://rpc.example/",
  STUDIO_DISCOVERY_TARGETS_JSON: JSON.stringify([target]) };
const config = studioConfig(env)!;
const card = () => ({ protocolVersion: "0.3.0", name: "Seller", description: "Read-only strategy",
  url: "https://seller.example/", version: "1", capabilities: {}, defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
  skills: [{ id: "negotiate", name: "Quote", description: "Signs a quote", tags: ["commerce"] }] });
const identity = (protocol="A2A", endpoint=url) => ({ owner: "0x0000000000000000000000000000000000000001",
  agentURI: `data:application/json;base64,${Buffer.from(JSON.stringify({name:"On-chain name",services:[{name:protocol,endpoint}]})).toString("base64")}` });
const signal = () => new AbortController().signal;
const reply = (body:unknown):Reply => ({ status:200, body, session:undefined });

it("A2A target is exclusive, revision-bound, and keeps old MCP target shape",()=>{
  assert.deepEqual(config.targets,[target]);
  const mcp=studioConfig({...env,STUDIO_DISCOVERY_TARGETS_JSON:JSON.stringify([{id:"7",mcpEndpoint:"https://seller.example/mcp"}])})!;
  assert.deepEqual(mcp.targets,[{id:"7",mcpEndpoint:"https://seller.example/mcp"}]);
  assert.notEqual(mcp.digest,config.digest);
  for(const value of [[{...target,mcpEndpoint:"https://seller.example/mcp"}],[{id:"7"}],[target,target]]){
    assert.equal(studioConfig({...env,STUDIO_DISCOVERY_TARGETS_JSON:JSON.stringify(value)}),null);
  }
  assert.equal(metadata(identity(),target),"On-chain name");
  assert.throws(()=>metadata(identity("MCP"),target));
  assert.throws(()=>metadata(identity("A2A","https://other.example/card"),target));
});
it("Card summary strips extensions/signatures and never treats auth declarations as access",()=>{
  const parsed=parseCard({...card(),security:[{bearer:[]}],securitySchemes:{bearer:{type:"http",scheme:"bearer"}},
    signatures:[{signature:"not-verified"}],capabilities:{extensions:[{uri:"http://127.0.0.1/secret",required:true}]}},url);
  assert.equal(parsed.authentication,"declared");assert.equal(parsed.invocationUrl,"https://seller.example/");
  assert.equal("signatures" in parsed,false);assert.equal("capabilities" in parsed,false);
  assert.equal(parseCard(card(),url).authentication,"not_declared");
});
it("Card schema rejects malformed required fields, cross-origin invocation and bounds",()=>{
  const bad:unknown[]=[null,{...card(),protocolVersion:"1.0.0"},{...card(),url:"https://other.example/"},
    {...card(),skills:[]},{...card(),skills:[...card().skills,...card().skills]},
    {...card(),skills:[{...card().skills[0],description:"x".repeat(4001)}]},
    {...card(),defaultInputModes:[]},{...card(),capabilities:null},{...card(),name:""},
    {...card(),security:[{missing:[]}]},{...card(),securitySchemes:{bad:{type:"http"}}},
    {...card(),securitySchemes:{bad:{type:"invalid"}}},{...card(),security:null},
    {...card(),securitySchemes:{bad:{type:["http"]}}},
    {...card(),securitySchemes:{bad:{type:"apiKey",name:"key",in:["header"]}}},
    {...card(),security:Array.from({length:16},()=>({bearer:Array.from({length:16},()=>"s".repeat(128))})),securitySchemes:{bearer:{type:"http",scheme:"bearer"}}},
    {...card(),securitySchemes:{bad:{type:"oauth2",flows:{invalid:{scopes:{}}}}}},
    {...card(),security:Array.from({length:17},()=>({}))},
    {...card(),securitySchemes:{bad:{type:"http",scheme:"bearer",description:"x".repeat(16385)}}}];
  for(const value of bad)assert.throws(()=>parseCard(value,url));
});
it("GET uses guarded numeric TLS connection, no body, no session or protocol headers",async()=>{
  let calls=0;
  const get=makeGetJson({resolve:async()=>[{address:"8.8.8.8"}],connect:(options,listener)=>{
    calls++;assert.equal(options.hostname,"8.8.8.8");assert.equal(options.servername,"seller.example");assert.equal(options.method,"GET");
    assert.deepEqual(options.headers,{host:"seller.example",accept:"application/json"});
    const req=new EventEmitter() as ClientRequest;
    req.end=((body:unknown)=>{assert.equal(body,undefined);const res=Readable.from([Buffer.from(JSON.stringify(card()))]) as IncomingMessage;
      res.statusCode=200;res.headers={"content-type":"application/json"};queueMicrotask(()=>listener(res));return req;}) as ClientRequest["end"];
    return req;
  }});
  assert.equal((await probeCard(url,signal(),get)).name,"Seller");assert.equal(calls,1);
  await assert.rejects(probeCard(url,signal(),async()=>({...reply(card()),status:202})));
});
it("GET refuses private DNS and redirects without fetching a second URL",async()=>{
  let calls=0;
  const denied=makeGetJson({resolve:async()=>[{address:"127.0.0.1"}],connect:()=>{calls++;throw Error("not reached");}});
  await assert.rejects(denied(url,signal()));assert.equal(calls,0);
  const redirect=makeGetJson({resolve:async()=>[{address:"8.8.8.8"}],connect:(_o,listener)=>{
    calls++;const req=new EventEmitter() as ClientRequest;
    req.end=(()=>{const res=Readable.from([]) as IncomingMessage;res.statusCode=302;res.headers={location:"http://127.0.0.1/"};
      queueMicrotask(()=>listener(res));return req;}) as ClientRequest["end"];return req;
  }});await assert.rejects(redirect(url,signal()));assert.equal(calls,1);
});
it("A2A job uses only GET after binding; stale and failed summaries clear",async()=>{
  let now=1000,gets=0,failed=false;const store=new MemoryStore(()=>now);
  const deps:ProbeDeps={now:()=>now,read:async()=>identity(),post:async()=>{throw Error("seller POST forbidden");},
    get:async endpoint=>{assert.equal(endpoint,url);gets++;if(failed)throw Error("offline");return reply(card());}};
  await studioJob(store,config,deps).run(signal());
  const observation=(await store.get<Catalog>(CATALOG_KEY))!.data.agents[0]!;
  assert.equal(observation.connected,true);assert.equal(observation.a2a?.skills[0]?.id,"negotiate");
  assert.deepEqual(observation.tools,[]);assert.equal("mcpEndpoint" in observation,false);assert.equal(gets,1);
  const before=process.env["DP_AUTH_TOKEN"];process.env["DP_AUTH_TOKEN"]="test";
  try{
    const app=createServer({store,scheduler:createScheduler(store),studio:config});
    now+=180001;const response=await app.request("/studio/agents/7",{headers:{"x-dp-token":"test"}});
    const data=await response.json() as {data:{connected:boolean;a2a:unknown}};
    assert.equal(data.data.connected,false);assert.equal(data.data.a2a,null);assert.equal(gets,1);
  }finally{if(before===undefined)delete process.env["DP_AUTH_TOKEN"];else process.env["DP_AUTH_TOKEN"]=before;}
  failed=true;await studioJob(store,config,deps).run(signal());
  const next=(await store.get<Catalog>(CATALOG_KEY))!.data.agents[0]!;assert.equal(next.connected,false);assert.equal(next.a2a,null);
  gets=0;await studioJob(store,config,{...deps,read:async()=>identity("MCP")}).run(signal());assert.equal(gets,0);
});
it("mixed targets preserve independent protocol projections",async()=>{
  const mcpTarget={id:"8",mcpEndpoint:"https://seller.example/mcp"};
  const mixed=studioConfig({...env,STUDIO_DISCOVERY_TARGETS_JSON:JSON.stringify([target,mcpTarget])})!;
  const store=new MemoryStore();let getCalls=0,postCalls=0;
  await studioJob(store,mixed,{now:Date.now,read:async id=>id==="7"?identity():identity("MCP",mcpTarget.mcpEndpoint),
    get:async()=>{getCalls++;return reply(card());},post:async(_u,raw)=>{postCalls++;const body=raw as {method:string};
      if(body.method==="initialize")return reply({jsonrpc:"2.0",id:1,result:{protocolVersion:"2025-06-18",capabilities:{tools:{}},serverInfo:{}}});
      if(body.method==="notifications/initialized")return {...reply(null),status:202};
      assert.equal(body.method,"tools/list");return reply({jsonrpc:"2.0",id:2,result:{tools:[]}});
    }}).run(signal());
  const agents=(await store.get<Catalog>(CATALOG_KEY))!.data.agents;assert.equal(agents.every(a=>a.connected),true);
  assert.equal("a2a" in agents.find(a=>a.id==="8")!,false);assert.equal(getCalls,1);assert.equal(postCalls,3);
});
