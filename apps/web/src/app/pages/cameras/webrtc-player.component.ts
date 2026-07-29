import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output, signal, ViewChild } from "@angular/core";
import { io, Socket } from "socket.io-client";

type StartResponse = { success:boolean; sessionId?:string; iceServers?:RTCIceServer[]; error?:string };
type SignalMessage = { sessionId:string; type:"answer"|"candidate"|"disconnect"; payload:string };

@Component({
  selector:"app-webrtc-player",
  standalone:true,
  template:`
    <video #video controls autoplay muted playsinline></video>
    @if(muted()){<button class="sound" (click)="enableSound()">🔊 Включить звук</button>}
    @if(status()){<p class="status">{{status()}}</p>}
  `,
  styles:[`
    :host{position:relative;display:block;width:100%;height:100%;min-width:0;overflow:hidden;background:#101622}
    video{display:block;width:100%;height:100%;object-fit:contain;background:#101622}
    .sound{position:absolute;z-index:2;right:10px;bottom:44px;padding:7px 10px;border:0;border-radius:7px;background:#fffffff0;color:#182033;font-weight:700}
    .status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;padding:8px 11px;border-radius:7px;background:#101828c9;color:#fff;font-size:12px;white-space:nowrap}
  `],
})
export class WebRtcPlayerComponent implements AfterViewInit,OnDestroy{
  @Input({required:true}) cameraId!:string;
  @Output() fallbackRequested=new EventEmitter<void>();
  @ViewChild("video",{static:true}) video!:ElementRef<HTMLVideoElement>;
  status=signal("Подключение WebRTC…"); muted=signal(true);
  private socket?:Socket;private peer?:RTCPeerConnection;private sessionId="";private fallbackSent=false;
  private timeout?:ReturnType<typeof setTimeout>;private disconnectTimeout?:ReturnType<typeof setTimeout>;
  private stream=new MediaStream();
  private silentContext?:AudioContext;private silentOscillator?:OscillatorNode;private silentTrack?:MediaStreamTrack;

  ngAfterViewInit(){
    const token=sessionStorage.getItem("access_token");
    if(!token)return this.fallback();
    this.socket=io("/webrtc",{path:"/socket.io",auth:{token},transports:["websocket"],timeout:10_000});
    this.socket.on("signal",(message:SignalMessage)=>void this.onSignal(message));
    this.socket.on("connect_error",()=>this.fallback());
    this.socket.on("connect",()=>{
      this.socket?.emit("start",{cameraId:this.cameraId},(response:StartResponse)=>{
        if(!response?.success||!response.sessionId)return this.fallback();
        this.sessionId=response.sessionId;
        void this.startPeer(response.iceServers||[]);
      });
    });
    this.timeout=setTimeout(()=>this.fallback(),15_000);
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
        if(this.timeout)clearTimeout(this.timeout);
        this.video.nativeElement.play().catch(()=>{});
      };
      this.peer.onicecandidate=event=>this.send("candidate",event.candidate?`a=${event.candidate.candidate}`:"");
      this.peer.onconnectionstatechange=()=>{
        const state=this.peer?.connectionState;
        if(state==="connected"){
          this.status.set("");
          if(this.timeout)clearTimeout(this.timeout);
          if(this.disconnectTimeout)clearTimeout(this.disconnectTimeout);
        }else if(state==="failed"||state==="closed")this.fallback();
        else if(state==="disconnected"){
          this.disconnectTimeout=setTimeout(()=>this.fallback(),5_000);
        }
      };
      const offer=await this.peer.createOffer();
      await this.peer.setLocalDescription(offer);
      const compactSdp=String(offer.sdp||"").replace(/\r\na=extmap[^\r\n]*/g,"");
      this.send("offer",compactSdp);
    }catch{this.fallback()}
  }

  private async onSignal(message:SignalMessage){
    if(message.sessionId!==this.sessionId||!this.peer)return;
    try{
      if(message.type==="answer")await this.peer.setRemoteDescription({type:"answer",sdp:message.payload});
      else if(message.type==="candidate"&&message.payload)await this.peer.addIceCandidate({candidate:message.payload,sdpMid:"0",sdpMLineIndex:0});
      else if(message.type==="disconnect")this.fallback();
    }catch{this.fallback()}
  }

  private send(type:"offer"|"candidate"|"disconnect",payload:string){
    if(this.socket?.connected&&this.sessionId)this.socket.emit("signal",{sessionId:this.sessionId,type,payload});
  }

  enableSound(){
    const video=this.video.nativeElement;
    video.muted=false;video.volume=1;this.muted.set(false);video.play().catch(()=>{});
  }

  private fallback(){
    if(this.fallbackSent)return;
    this.fallbackSent=true;this.cleanup();this.fallbackRequested.emit();
  }

  private cleanup(){
    if(this.timeout)clearTimeout(this.timeout);
    if(this.disconnectTimeout)clearTimeout(this.disconnectTimeout);
    if(this.sessionId)this.send("disconnect","");
    this.peer?.close();this.socket?.disconnect();
    this.peer=undefined;this.socket=undefined;
    this.silentTrack?.stop();this.silentOscillator?.stop();void this.silentContext?.close();
    this.silentTrack=undefined;this.silentOscillator=undefined;this.silentContext=undefined;
    for(const track of this.stream.getTracks())track.stop();
  }

  ngOnDestroy(){this.cleanup()}
}
