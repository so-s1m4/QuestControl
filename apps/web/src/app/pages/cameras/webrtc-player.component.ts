import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output, signal, ViewChild } from "@angular/core";
import { io, Socket } from "socket.io-client";

type StartResponse = { success:boolean; sessionId?:string; iceServers?:RTCIceServer[]; error?:string };
type SignalMessage = { sessionId:string; type:"answer"|"candidate"|"disconnect"; payload:string };

@Component({
  selector:"app-webrtc-player",
  standalone:true,
  template:`
    <video #video controls autoplay muted playsinline></video>
    @if(status()){<p class="status">{{status()}}</p>}
  `,
  styles:[`
    :host{position:relative;display:block;width:100%;height:100%;min-width:0;overflow:hidden;background:#101622}
    video{display:block;width:100%;height:100%;object-fit:contain;background:#101622}
    .status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;padding:8px 11px;border-radius:7px;background:#101828c9;color:#fff;font-size:12px;white-space:nowrap}
  `],
})
export class WebRtcPlayerComponent implements AfterViewInit,OnDestroy{
  @Input({required:true}) cameraId!:string;
  @Output() fallbackRequested=new EventEmitter<void>();
  @ViewChild("video",{static:true}) video!:ElementRef<HTMLVideoElement>;
  status=signal("Подключение WebRTC…");
  private socket?:Socket;private peer?:RTCPeerConnection;private sessionId="";private fallbackSent=false;
  private timeout?:ReturnType<typeof setTimeout>;private disconnectTimeout?:ReturnType<typeof setTimeout>;
  private stream=new MediaStream();
  private remoteAnswerAccepted=false;
  private remoteCandidates=new Set<string>();
  private silentContext?:AudioContext;private silentOscillator?:OscillatorNode;private silentTrack?:MediaStreamTrack;

  ngAfterViewInit(){
    const token=sessionStorage.getItem("access_token");
    if(!token)return this.fallback("missing-token");
    this.socket=io("/webrtc",{path:"/socket.io",auth:{token},transports:["websocket"],timeout:10_000});
    this.socket.on("signal",(message:SignalMessage)=>void this.onSignal(message));
    this.socket.on("connect_error",error=>this.fallback("socket-connect-error",error.message));
    this.socket.on("connect",()=>{
      this.socket?.emit("start",{cameraId:this.cameraId},(response:StartResponse)=>{
        if(!response?.success||!response.sessionId)return this.fallback("session-start-failed",response?.error||"");
        this.sessionId=response.sessionId;
        this.diagnostic("session-started");
        void this.startPeer(response.iceServers||[]);
      });
    });
    this.timeout=setTimeout(()=>this.fallback("media-timeout"),15_000);
  }

  private async startPeer(iceServers:RTCIceServer[]){
    try{
      this.peer=new RTCPeerConnection({iceServers});
      const AudioContextClass=window.AudioContext||(window as typeof window&{webkitAudioContext:typeof AudioContext}).webkitAudioContext;
      this.silentContext=new AudioContextClass();
      const destination=this.silentContext.createMediaStreamDestination();
      const gain=this.silentContext.createGain();
      gain.gain.value=0;
      this.silentOscillator=this.silentContext.createOscillator();
      this.silentOscillator.connect(gain);gain.connect(destination);this.silentOscillator.start();
      this.silentTrack=destination.stream.getAudioTracks()[0];
      this.peer.addTrack(this.silentTrack,destination.stream);
      this.peer.addTransceiver("video",{direction:"recvonly"});
      this.peer.ontrack=event=>{
        if(!this.stream.getTracks().some(track=>track.id===event.track.id))this.stream.addTrack(event.track);
        this.video.nativeElement.srcObject=this.stream;
        this.status.set("");
        this.diagnostic("media-track",event.track.kind);
        if(this.timeout)clearTimeout(this.timeout);
        this.video.nativeElement.play().catch(()=>{});
      };
      this.peer.onicecandidate=event=>this.send("candidate",event.candidate?`a=${event.candidate.candidate}`:"");
      this.peer.onconnectionstatechange=()=>{
        const state=this.peer?.connectionState;
        if(state)this.diagnostic("connection-state",state);
        if(state==="connected"){
          this.status.set("");
          if(this.timeout)clearTimeout(this.timeout);
          if(this.disconnectTimeout)clearTimeout(this.disconnectTimeout);
        }else if(state==="failed"||state==="closed")this.fallback("connection-state",state);
        else if(state==="disconnected"){
          this.disconnectTimeout=setTimeout(()=>this.fallback("connection-disconnected"),5_000);
        }
      };
      const offer=await this.peer.createOffer();
      await this.peer.setLocalDescription(offer);
      const compactSdp=String(offer.sdp||"").replace(/\r\na=extmap[^\r\n]*/g,"");
      this.send("offer",compactSdp);
    }catch(error){this.fallback("peer-error",error instanceof Error?error.message:String(error))}
  }

  private async onSignal(message:SignalMessage){
    if(message.sessionId!==this.sessionId||!this.peer)return;
    try{
      if(message.type==="answer"){
        if(this.remoteAnswerAccepted||this.peer.signalingState!=="have-local-offer"){this.diagnostic("duplicate-answer",this.peer.signalingState);return}
        this.remoteAnswerAccepted=true;
        this.diagnostic("camera-answer");await this.peer.setRemoteDescription({type:"answer",sdp:message.payload});
      }
      else if(message.type==="candidate"&&message.payload){
        if(this.remoteCandidates.has(message.payload))return;
        this.remoteCandidates.add(message.payload);
        await this.peer.addIceCandidate({candidate:message.payload,sdpMid:"0",sdpMLineIndex:0});
      }
      else if(message.type==="disconnect")this.fallback("camera-disconnect");
    }catch(error){this.fallback("signal-error",error instanceof Error?error.message:String(error))}
  }

  private send(type:"offer"|"candidate"|"disconnect",payload:string){
    if(this.socket?.connected&&this.sessionId)this.socket.emit("signal",{sessionId:this.sessionId,type,payload});
  }

  private diagnostic(stage:string,detail=""){this.socket?.emit("diagnostic",{cameraId:this.cameraId,stage,detail:detail.slice(0,160)})}

  private fallback(stage:string,detail=""){
    if(this.fallbackSent)return;
    this.diagnostic(stage,detail);
    this.fallbackSent=true;this.cleanup();this.fallbackRequested.emit();
  }

  private cleanup(){
    if(this.timeout)clearTimeout(this.timeout);
    if(this.disconnectTimeout)clearTimeout(this.disconnectTimeout);
    if(this.sessionId)this.send("disconnect","");
    this.peer?.close();this.socket?.disconnect();
    this.peer=undefined;this.socket=undefined;
    this.remoteAnswerAccepted=false;
    this.remoteCandidates.clear();
    this.silentTrack?.stop();this.silentOscillator?.stop();void this.silentContext?.close();
    this.silentTrack=undefined;this.silentOscillator=undefined;this.silentContext=undefined;
    for(const track of this.stream.getTracks())track.stop();
  }

  ngOnDestroy(){this.cleanup()}
}
