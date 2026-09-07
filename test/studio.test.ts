import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { ClientRequest, IncomingMessage, RequestOptions } from "node:http";
import { encodeFunctionData, encodeAbiParameters, parseAbi } from "viem";
import { studioConfig, safeUrl, CATALOG_KEY, REGISTRY, type StudioConfig } from "../src/studio/config.js";
import { makePostJson, publicIPv4, abortable, type PostJson } from "../src/studio/http.js";
import { probeMcp, metadata } from "../src/studio/probe.js";
import { readIdentity, readRpcAllowed } from "../src/studio/registry.js";
import { studioJob, type ProbeDeps } from "../src/studio/catalog.js";
import { MemoryStore } from "../src/core/store.js";
import { createServer } from "../src/server.js";
import { createScheduler } from "../src/core/scheduler.js";

const endpoint = "https://seller.example/mcp";
const config = studioConfig({ STUDIO_DISCOVERY_ENABLED: "true", STUDIO_DISCOVERY_RPC_URL: "https://rpc.example/",
  STUDIO_DISCOVERY_TARGETS_JSON: JSON.stringify([{ id: "429", mcpEndpoint: endpoint }]) })!;
const signal = () => new AbortController().signal;
const owner = "0x0000000000000000000000000000000000000001";
const uri = (value: unknown) => `data:application/json;base64,${Buffer.from(JSON.stringify(value)).toString("base64")}`;
const identity = { owner, agentURI: uri({ name: "Example", services: [{ name: "MCP", endpoint }] }) };
const tool = { name: "negotiate", description: "May sign a quote", inputSchema: { type: "object" } };
function fakeMcp(calls: unknown[] = []): PostJson {
  return async (_url, body, _signal, session, protocol) => {
    calls.push(body);
    const b = body as { method: string; id?: number };
    if (b.method === "initialize") return { status: 200, session: "session-1", body: { jsonrpc: "2.0", id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "example", version: "1" } } } };
    assert.equal(session, "session-1"); assert.equal(protocol, "2025-06-18");
    if (b.method === "notifications/initialized") return { status: 202, body: null, session: undefined };
    assert.equal(b.method, "tools/list");
    return { status: 200, session: undefined, body: { jsonrpc: "2.0", id: 2, result: { tools: [tool] } } };
  };
}
describe("Studio backend boundaries", () => {
  it("disabled config does not inspect other settings; malformed enabled stays optional", () => {
    assert.equal(studioConfig(new Proxy({ STUDIO_DISCOVERY_ENABLED: "false" }, { get(t,k) {
      if (k !== "STUDIO_DISCOVERY_ENABLED") throw new Error("unexpected access"); return t.STUDIO_DISCOVERY_ENABLED;
    } })), null);
    assert.equal(studioConfig({ STUDIO_DISCOVERY_ENABLED: "true" }), null);
    for (const id of ["01", "-1", "9007199254740992", "1e3"]) assert.equal(studioConfig({ STUDIO_DISCOVERY_ENABLED:"true",
      STUDIO_DISCOVERY_RPC_URL:"https://rpc.example/", STUDIO_DISCOVERY_TARGETS_JSON:JSON.stringify([{id,mcpEndpoint:endpoint}]) }), null);
    assert.ok(config);
  });
  it("rejects URL tricks and non-public IPv4 ranges", () => {
    for (const value of ["http://seller.example/mcp", "https://127.0.0.1/mcp", "https://user:pass@seller.example/mcp",
      "https://seller.example/mcp?q=x", "https://seller.example:444/mcp", "https://[::1]/mcp"]) assert.throws(() => safeUrl(value));
    for (const ip of ["127.0.0.1","10.0.0.1","100.64.0.1","169.254.169.254","172.16.0.1","192.168.1.1","198.18.0.1","224.0.0.1","240.0.0.1","::1"]) assert.equal(publicIPv4(ip), false);
    assert.equal(publicIPv4("8.8.8.8"), true);
  });
  it("pins the validated IP and rejects redirects, large bodies, and rebinding answers", async () => {
    let connects = 0; let options: RequestOptions | undefined;
    const run = (status: number, bytes: number, addresses = ["8.8.8.8"]) => makePostJson({ resolve: async () => addresses.map(address => ({address})),
      connect: (opts, listener) => {
        connects++; options = opts;
        const req = new EventEmitter() as ClientRequest;
        req.end = (() => {
          const res = Readable.from([Buffer.alloc(bytes, 32)]) as IncomingMessage;
          res.statusCode = status; res.headers = { "content-type": "application/json" };
          queueMicrotask(() => listener(res)); return req;
        }) as ClientRequest["end"];
        req.destroy = () => req;
        return req;
      } });
    await assert.rejects(run(302,0)(endpoint,{},signal())); assert.equal(connects,1);
    const tls = options as RequestOptions & {servername:string};
    assert.equal(tls.hostname,"8.8.8.8"); assert.equal(tls.servername,"seller.example");
    assert.equal((tls.headers as Record<string,unknown>)["host"],"seller.example");
    await assert.rejects(run(200,262145)(endpoint,{},signal()));
    const before = connects;
    await assert.rejects(run(200,0,["8.8.8.8","127.0.0.1"])(endpoint,{},signal()));
    assert.equal(connects,before);
    const controller = new AbortController();
    const waiting = abortable(new Promise(() => {}), controller.signal); controller.abort(); await assert.rejects(waiting);
  });
  it("reads with the real SDK, no wallet, one attempt even for ID 429", async () => {
    let calls = 0;
    const failing: PostJson = async (_u, raw) => {
      const body = raw as {id:number;method:string};
      if(body.method === "eth_chainId") return {status:200,session:undefined,body:{jsonrpc:"2.0",id:body.id,result:"0x38"}};
      calls++; throw new Error("studio_upstream_failed");
    };
    await assert.rejects(readIdentity("429",config.rpcUrl,signal(),failing)); assert.equal(calls,1);
    const abi = parseAbi(["function getAgentWallet(uint256) view returns (address)","function ownerOf(uint256) view returns (address)","function tokenURI(uint256) view returns (string)"]);
    for(const functionName of ["getAgentWallet","ownerOf","tokenURI"] as const) assert.equal(readRpcAllowed("eth_call",[{to:REGISTRY,data:encodeFunctionData({abi,functionName,args:[429n]})},"latest"]),true);
    for(const method of ["eth_sendRawTransaction","eth_sendTransaction","eth_sign","personal_sign"]) assert.equal(readRpcAllowed(method,[]),false);
    assert.equal(readRpcAllowed("eth_call",[{to:owner,data:"0x"},"latest"]),false);
    const successful: PostJson = async (_u, raw) => {
      const body = raw as {id:number;method:string;params:{data:string}[]};
      const result = body.method === "eth_chainId" ? "0x38" : body.params[0]!.data.startsWith("0xc87b56dd")
        ? encodeAbiParameters([{type:"string"}],[identity.agentURI]) : encodeAbiParameters([{type:"address"}],[owner]);
      return {status:200,session:undefined,body:{jsonrpc:"2.0",id:body.id,result}};
    };
    assert.deepEqual(await readIdentity("429",config.rpcUrl,signal(),successful),identity);
  });
  it("metadata binds the declared exact endpoint; no HTTP metadata is fetched", () => {
    assert.equal(metadata(identity,config.targets[0]!),"Example");
    for(const agentURI of ["https://seller.example/agent.json",uri({name:"Example",services:[{name:"MCP",endpoint:"https://other.example/mcp"}]}),uri({name:"Example",services:[]})]) assert.throws(()=>metadata({owner,agentURI},config.targets[0]!));
  });
  it("lists potentially signing tools without calling them or keeping schemas", async () => {
    const calls: unknown[] = [];
    assert.deepEqual(await probeMcp(endpoint,signal(),fakeMcp(calls)),[{name:"negotiate",description:"May sign a quote"}]);
    assert.deepEqual(calls.map(c=>(c as {method:string}).method),["initialize","notifications/initialized","tools/list"]);
  });
  it("rejects protocol versions, wrong IDs, server requests and incomplete pagination", async () => {
    for(const alteration of ["version","id","method","cursor"]){
      const base=fakeMcp(); const post:PostJson=async(...args)=>{
        const response=await base(...args); const b=response.body as {id?:number;method?:string;result?:Record<string,unknown>}|null;
        if(b?.result && b.id===1 && alteration==="version") b.result["protocolVersion"]="2099-01-01";
        if(b?.id===2){if(alteration==="id")b.id=3;if(alteration==="method")b.method="tools/call";if(alteration==="cursor")b.result!["nextCursor"]="more";}
        return response;
      };
      await assert.rejects(probeMcp(endpoint,signal(),post));
    }
  });
  it("caches failures independently, clears tools, and projects stale reads without egress", async () => {
    let now=1000;const store=new MemoryStore(()=>now);let fail=false;let reads=0;
    const deps:ProbeDeps={post:fakeMcp(),now:()=>now,read:async()=>{reads++;if(fail)throw new Error("secret");return identity;}};
    const job=studioJob(store,config,deps);await job.run(signal());
    const prior=process.env["DP_AUTH_TOKEN"];process.env["DP_AUTH_TOKEN"]="studio-test";
    try{
      const app=createServer({store,scheduler:createScheduler(store),studio:config});
      assert.equal((await app.request("/studio/agents")).status,401);
      const get=()=>app.request("/studio/agents",{headers:{"x-dp-token":"studio-test"}});
      assert.equal((await get()).status,200);assert.equal(reads,1);
      now+=180001; const stale=await (await get()).json() as {data:{connected:boolean;tools:unknown[]}[]};
      assert.equal(stale.data[0]!.connected,false);assert.deepEqual(stale.data[0]!.tools,[]);
      fail=true;await job.run(signal());const failed=await (await get()).json() as {data:{connected:boolean;errorCode:string;tools:unknown[]}[]};
      assert.equal(failed.data[0]!.connected,false);assert.deepEqual(failed.data[0]!.tools,[]);assert.equal(failed.data[0]!.errorCode,"studio_probe_failed");
      const changed=createServer({store,scheduler:createScheduler(store),studio:{...config,digest:"different"}});
      assert.equal((await changed.request("/studio/agents",{headers:{"x-dp-token":"studio-test"}})).status,503);
      delete process.env["DP_AUTH_TOKEN"];assert.equal((await get()).status,503);
      const disabled=createServer({store,scheduler:createScheduler(store)});assert.equal((await disabled.request("/studio/agents")).status,404);
    }finally{if(prior===undefined)delete process.env["DP_AUTH_TOKEN"];else process.env["DP_AUTH_TOKEN"]=prior;}
  });
  it("limits concurrency and never writes an aborted cycle",async()=>{
    const store=new MemoryStore();let active=0,max=0;
    const cfg:StudioConfig={...config,targets:["1","2","3","4"].map(id=>({id,mcpEndpoint:endpoint}))};
    await studioJob(store,cfg,{post:fakeMcp(),now:Date.now,read:async()=>{active++;max=Math.max(max,active);await new Promise(r=>setTimeout(r,2));active--;return identity;}}).run(signal());
    assert.equal(max,2);
    const controller=new AbortController();const empty=new MemoryStore();
    await assert.rejects(studioJob(empty,config,{post:fakeMcp(),now:Date.now,read:async()=>{controller.abort();return identity;}}).run(controller.signal));
    assert.equal(await empty.get(CATALOG_KEY),null);
  });
});
