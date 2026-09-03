import "dotenv/config";
import os from "node:os";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import { z } from "zod";

const config = z.object({
  VPS_URL:z.string().url(), AGENT_ID:z.string().min(3), AGENT_TOKEN:z.string().min(16), ROOM_ID:z.string().uuid(),
  LOCAL_ORIGINS:z.string(), ALLOWED_COMMANDS:z.string(), COMMAND_API:z.string().url(),
  HEARTBEAT_MS:z.coerce.number().default(15000), REQUEST_TIMEOUT_MS:z.coerce.number().default(5000),
  ROOM_CONFIG_PATH:z.string().startsWith("/").default("/api/room-config"),
  AUDIO_PLAYER:z.enum(["ffplay","mpv"]).default("ffplay"),
  AUDIO_DEVICE:z.string().max(200).optional()
}).parse(process.env);
const origins = new Set(config.LOCAL_ORIGINS.split(",").map(v => new URL(v.trim()).origin));
const commands = new Set(config.ALLOWED_COMMANDS.split(",").map(v=>v.trim()).filter(Boolean));
const httpAction=z.object({
  method:z.enum(["POST","PUT","PATCH"]).default("POST"),path:z.string().startsWith("/").max(240),
  body:z.record(z.unknown()).default({}),valueField:z.string().min(1).max(80).optional()
}).strict();
const controlBase={id:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),label:z.string().min(1).max(80)};
const roomConfigSchema=z.object({
  version:z.literal(1),title:z.string().min(1).max(120),
  state:z.object({path:z.string().startsWith("/").max(240),pollMs:z.number().int().min(500).max(60_000).default(2000)}).strict(),
  blocks:z.array(z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),title:z.string().min(1).max(80),width:z.enum(["full","half","third"]).default("half"),categories:z.array(z.object({
    id:z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),title:z.string().min(1).max(80),controls:z.array(z.discriminatedUnion("type",[
      z.object({...controlBase,type:z.literal("button"),action:httpAction}).strict(),
      z.object({...controlBase,type:z.literal("checkbox"),statePath:z.string().min(1).max(160),onLabel:z.string().max(40).optional(),offLabel:z.string().max(40).optional(),onAction:httpAction,offAction:httpAction}).strict(),
      z.object({...controlBase,type:z.literal("slider"),statePath:z.string().min(1).max(160),min:z.number(),max:z.number(),step:z.number().positive(),unit:z.string().max(20).optional(),action:httpAction}).strict(),
      z.object({...controlBase,type:z.literal("indicator"),statePath:z.string().min(1).max(160),onLabel:z.string().max(40).optional(),offLabel:z.string().max(40).optional()}).strict(),
    ])).max(50)
  }).strict()).max(20)}).strict()).max(20)
}).strict();
const socket = io(`${config.VPS_URL.replace(/\/agent$/,"")}/agent`, {
  path:"/socket.io", transports:["websocket"], reconnection:true, reconnectionDelayMax:30000,
  auth:{ agentId:config.AGENT_ID, token:config.AGENT_TOKEN }
});
let voicePlayer;

function stopVoice() {
  if(!voicePlayer) return;
  voicePlayer.stdin?.end();
  const player=voicePlayer;
  setTimeout(()=>player.exitCode===null&&player.kill("SIGTERM"),1500).unref();
  voicePlayer=undefined;
}
function startVoice(contentType) {
  stopVoice();
  if(!["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg","audio/mpeg","audio/wav","audio/x-wav","audio/mp4","audio/x-m4a"].includes(contentType)) {
    throw new Error("VOICE_FORMAT_NOT_ALLOWED");
  }
  const args=config.AUDIO_PLAYER==="mpv"
    ? ["--no-video","--really-quiet","--cache=no","--audio-buffer=0.1",...(config.AUDIO_DEVICE?[`--audio-device=${config.AUDIO_DEVICE}`]:[]),"-"]
    : ["-nodisp","-autoexit","-loglevel","error","-fflags","nobuffer","-i","pipe:0"];
  const playerEnv=config.AUDIO_PLAYER==="ffplay"&&config.AUDIO_DEVICE
    ? {...process.env,AUDIODEV:config.AUDIO_DEVICE,SDL_AUDIO_ALSA_DEFAULT_DEVICE:config.AUDIO_DEVICE}
    : process.env;
  voicePlayer=spawn(config.AUDIO_PLAYER,args,{stdio:["pipe","ignore","pipe"],env:playerEnv});
  voicePlayer.on("error",error=>console.error("Voice player failed:",error.message));
  voicePlayer.stderr?.on("data",data=>console.error("Voice player:",String(data).trim()));
  voicePlayer.on("exit",()=>{ voicePlayer=undefined; });
}

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
async function responseBody(response) {
  const text=await response.text();
  if(!text) return {};
  if((response.headers.get("content-type")||"").includes("json")) {
    try { return JSON.parse(text); } catch { throw new Error("LOCAL_API_INVALID_JSON"); }
  }
  return {message:text.slice(0,4096)};
}
async function execute(message) {
  if (!commands.has(message.action)) throw new Error("COMMAND_NOT_ALLOWED");
  const url=safeUrl(config.COMMAND_API,`./${message.action}`);
  const response=await localFetch(url,{method:"POST",headers:{"content-type":"application/json","x-quest-command-id":message.id},body:JSON.stringify({roomId:config.ROOM_ID,...message.payload})});
  if(!response.ok) throw new Error(`LOCAL_API_${response.status}`);
  return responseBody(response);
}
async function loadRoomConfig() {
  const response=await localFetch(safeUrl([...origins][0],config.ROOM_CONFIG_PATH),{method:"GET",headers:{accept:"application/json"}});
  if(!response.ok) throw new Error(`ROOM_CONFIG_${response.status}`);
  return roomConfigSchema.parse(await responseBody(response));
}
function publicManifest(roomConfig) {
  return {version:roomConfig.version,title:roomConfig.title,state:{pollMs:roomConfig.state.pollMs},blocks:roomConfig.blocks.map(block=>({
    id:block.id,title:block.title,width:block.width,categories:block.categories.map(category=>({id:category.id,title:category.title,controls:category.controls.map(control=>{
        const visible={id:control.id,type:control.type,label:control.label};
        for(const key of ["statePath","onLabel","offLabel","min","max","step","unit"]) if(control[key]!==undefined) visible[key]=control[key];
        return visible;
      })}))
  }))};
}
async function runPanelAction(action,dynamicValue) {
  const body={...action.body};
  if(action.valueField) body[action.valueField]=dynamicValue;
  const response=await localFetch(safeUrl([...origins][0],action.path),{method:action.method,headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  if(!response.ok) throw new Error(`CONTROL_ACTION_${response.status}`);
  return responseBody(response);
}
socket.on("connect",()=>console.log("Connected to QuestControl"));
socket.on("connect_error",error=>console.error("Connection failed:",error.message));
socket.on("command",async(message,ack)=>{
  try { ack({success:true,result:await execute(message)}); }
  catch(error) { ack({success:false,error:error.message}); }
});
socket.on("control-panel",async(message,ack)=>{
  try {
    const roomConfig=await loadRoomConfig();
    if(message.operation==="manifest") return ack({success:true,result:publicManifest(roomConfig)});
    if(message.operation==="state") {
      const response=await localFetch(safeUrl([...origins][0],roomConfig.state.path),{method:"GET",headers:{accept:"application/json"}});
      if(!response.ok) throw new Error(`CONTROL_STATE_${response.status}`);
      return ack({success:true,result:await responseBody(response)});
    }
    if(message.operation!=="execute") throw new Error("CONTROL_OPERATION_NOT_ALLOWED");
    const control=roomConfig.blocks.flatMap(block=>block.categories).flatMap(category=>category.controls).find(item=>item.id===message.controlId);
    if(!control||control.type==="indicator") throw new Error("CONTROL_NOT_FOUND");
    if(control.type==="button") return ack({success:true,result:await runPanelAction(control.action)});
    if(control.type==="checkbox") {
      if(typeof message.checked!=="boolean") throw new Error("CHECKED_REQUIRED");
      return ack({success:true,result:await runPanelAction(message.checked?control.onAction:control.offAction,message.checked)});
    }
    if(typeof message.value!=="number"||message.value<control.min||message.value>control.max) throw new Error("SLIDER_VALUE_INVALID");
    return ack({success:true,result:await runPanelAction(control.action,message.value)});
  } catch(error) { ack({success:false,error:error.message}); }
});
socket.on("krampus",async(message,ack)=>{
  try {
    const routes={
      status:{path:"/api/status",method:"GET"},
      sensors:{path:"/api/sensors",method:"GET"},
      logs:{path:"/api/serial/tail",method:"GET"},
      serial:{path:"/api/serial/config",method:"POST",body:{path:message.path}},
      command:{path:"/api/admin",method:"POST",body:{cmd:message.command}},
      sound:{path:message.action==="stop"?"/api/sound/stop":"/api/sound/play",method:"POST",body:message.action==="stop"?{}:{sound:message.sound}},
    };
    const route=routes[message.operation];
    if(!route) throw new Error("KRAMPUS_OPERATION_NOT_ALLOWED");
    const url=safeUrl([...origins][0],route.path);
    const response=await localFetch(url,{method:route.method,headers:route.body?{"content-type":"application/json"}:undefined,body:route.body?JSON.stringify(route.body):undefined});
    if(!response.ok) throw new Error(`KRAMPUS_API_${response.status}`);
    ack({success:true,result:await responseBody(response)});
  } catch(error) { ack({success:false,error:error.message}); }
});
socket.on("voice",(message,ack=()=>{})=>{
  try {
    if(message.operation==="start") startVoice(message.contentType);
    else if(message.operation==="chunk") {
      if(!voicePlayer?.stdin?.writable) throw new Error("VOICE_NOT_STARTED");
      const chunk=Buffer.isBuffer(message.data)?message.data:Buffer.from(message.data);
      if(chunk.length>256_000) throw new Error("VOICE_CHUNK_TOO_LARGE");
      voicePlayer.stdin.write(chunk);
    } else if(message.operation==="stop") stopVoice();
    else throw new Error("VOICE_OPERATION_NOT_ALLOWED");
    ack({success:true});
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
process.on("SIGTERM",()=>{stopVoice();socket.close();process.exit(0)});
