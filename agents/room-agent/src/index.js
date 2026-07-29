import "dotenv/config";
import os from "node:os";
import { spawn } from "node:child_process";
import { io } from "socket.io-client";
import { z } from "zod";

const config = z.object({
  VPS_URL:z.string().url(), AGENT_ID:z.string().min(3), AGENT_TOKEN:z.string().min(16), ROOM_ID:z.string().uuid(),
  LOCAL_ORIGINS:z.string(), ALLOWED_COMMANDS:z.string(), COMMAND_API:z.string().url(),
  HEARTBEAT_MS:z.coerce.number().default(15000), REQUEST_TIMEOUT_MS:z.coerce.number().default(5000),
  AUDIO_PLAYER:z.enum(["ffplay","mpv"]).default("ffplay"),
  AUDIO_DEVICE:z.string().max(200).optional()
}).parse(process.env);
const origins = new Set(config.LOCAL_ORIGINS.split(",").map(v => new URL(v.trim()).origin));
const commands = new Set(config.ALLOWED_COMMANDS.split(",").map(v=>v.trim()).filter(Boolean));
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
