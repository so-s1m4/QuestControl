import "dotenv/config";
import os from "node:os";
import { io } from "socket.io-client";
import { z } from "zod";

const config = z.object({
  VPS_URL:z.string().url(), AGENT_ID:z.string().min(3), AGENT_TOKEN:z.string().min(16), ROOM_ID:z.string().uuid(),
  LOCAL_ORIGINS:z.string(), ALLOWED_COMMANDS:z.string(), COMMAND_API:z.string().url(),
  HEARTBEAT_MS:z.coerce.number().default(15000), REQUEST_TIMEOUT_MS:z.coerce.number().default(5000)
}).parse(process.env);
const origins = new Set(config.LOCAL_ORIGINS.split(",").map(v => new URL(v).origin));
const commands = new Set(config.ALLOWED_COMMANDS.split(","));
const socket = io(`${config.VPS_URL.replace(/\/agent$/,"")}/agent`, {
  path:"/socket.io", transports:["websocket"], reconnection:true, reconnectionDelayMax:30000,
  auth:{ agentId:config.AGENT_ID, token:config.AGENT_TOKEN }
});

function safeUrl(base,path="") {
  const url = new URL(path,base);
  if (!origins.has(url.origin)) throw new Error("LOCAL_ORIGIN_NOT_ALLOWED");
  if (!["http:","https:"].includes(url.protocol)) throw new Error("PROTOCOL_NOT_ALLOWED");
  url.username=""; url.password="";
  return url;
}
async function localFetch(url, options={}) {
  return fetch(url,{...options,redirect:"manual",signal:AbortSignal.timeout(config.REQUEST_TIMEOUT_MS)});
}
async function execute(message) {
  if (!commands.has(message.action)) throw new Error("COMMAND_NOT_ALLOWED");
  const url=safeUrl(config.COMMAND_API,`./${message.action}`);
  const response=await localFetch(url,{method:"POST",headers:{"content-type":"application/json","x-quest-command-id":message.id},body:JSON.stringify({roomId:config.ROOM_ID,...message.payload})});
  if(!response.ok) throw new Error(`LOCAL_API_${response.status}`);
  const type=response.headers.get("content-type")||"";
  return type.includes("json") ? response.json() : {message:(await response.text()).slice(0,4096)};
}
socket.on("connect",()=>console.log("Connected to QuestControl"));
socket.on("connect_error",error=>console.error("Connection failed:",error.message));
socket.on("command",async(message,ack)=>{
  try { ack({success:true,result:await execute(message)}); }
  catch(error) { ack({success:false,error:error.message}); }
});
socket.on("krampus",async(message,ack)=>{
  try {
    const routes={
      status:{path:"/api/status",method:"GET"},
      sensors:{path:"/api/sensors",method:"GET"},
      logs:{path:"/api/serial/tail",method:"GET"},
      command:{path:"/api/admin",method:"POST",body:{cmd:message.command}},
      sound:{path:message.action==="stop"?"/api/sound/stop":"/api/sound/play",method:"POST",body:message.action==="stop"?{}:{sound:message.sound}},
    };
    const route=routes[message.operation];
    if(!route) throw new Error("KRAMPUS_OPERATION_NOT_ALLOWED");
    const url=safeUrl([...origins][0],route.path);
    const response=await localFetch(url,{method:route.method,headers:route.body?{"content-type":"application/json"}:undefined,body:route.body?JSON.stringify(route.body):undefined});
    if(!response.ok) throw new Error(`KRAMPUS_API_${response.status}`);
    ack({success:true,result:await response.json()});
  } catch(error) { ack({success:false,error:error.message}); }
});
socket.on("proxy",async(message,ack)=>{
  try {
    const url=safeUrl([...origins][0],message.path);
    const response=await localFetch(url,{method:"GET",headers:{"accept":"text/html,application/json,image/*"}});
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>2_000_000) throw new Error("RESPONSE_TOO_LARGE");
    ack({success:true,status:response.status,headers:{"content-type":response.headers.get("content-type")||"application/octet-stream","cache-control":"no-store"},body:bytes.toString("base64")});
  } catch(error) { ack({success:false,error:error.message}); }
});
setInterval(()=>socket.connected && socket.emit("heartbeat",{
  roomId:config.ROOM_ID,hostname:os.hostname(),uptime:Math.floor(os.uptime()),load:os.loadavg()[0],
  freeMemory:os.freemem(),version:"0.1.0",timestamp:new Date().toISOString()
}),config.HEARTBEAT_MS).unref();
process.on("SIGTERM",()=>{socket.close();process.exit(0)});
