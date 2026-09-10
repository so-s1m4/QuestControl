import { AfterViewInit, Component, ElementRef, EventEmitter, Input, OnDestroy, Output, signal, ViewChild } from "@angular/core";
import { io, Socket } from "socket.io-client";

type StartResponse = { success:boolean; sessionId?:string; iceServers?:RTCIceServer[]; error?:string };
type SignalMessage = { sessionId:string; type:"answer"|"candidate"|"disconnect"; payload:string };
type BBox = { x:number; y:number; width:number; height:number };
type Person = { trackId?:number; confidence:number; bbox:BBox };

@Component({
  selector:"app-webrtc-player",
  standalone:true,
  template:`
    <video #video controls autoplay muted playsinline (loadedmetadata)="onResize()" (resize)="onResize()"></video>
    @if(showAiOverlay()){
      <canvas #canvas class="ai-canvas"></canvas>
      <div class="ai-badge" [class.detected]="peopleCount()>0">
        <span>PEOPLE: {{peopleCount()}}</span>
      </div>
      @if(headsetState(); as hs){
        @if(hs.modelStatus === 'MODEL_UNAVAILABLE' || hs.status === 'MODEL_UNAVAILABLE'){
          <div class="vr-badge error">
            <span>VR: МОДЕЛЬ НЕДОСТУПНА</span>
          </div>
        } @else {
          <div class="vr-badge">
            <span>VR: {{hs.totalDetected}}</span>
            <small>База: {{hs.onChargingBaseCount ?? hs.chargingBaseCount}}</small>
            @if((hs.notOnBaseCount ?? hs.outsideZoneCount) > 0){
              <strong class="warn">Не на базе: {{hs.notOnBaseCount ?? hs.outsideZoneCount}}</strong>
            }
          </div>
        }
      }
    }
    <button class="ai-toggle-btn" [class.on]="showAiOverlay()" (click)="toggleOverlay($event)" [title]="showAiOverlay()?'Скрыть AI рамки':'Показать AI рамки'">AI</button>
    @if(status()){<p class="status">{{status()}}</p>}
  `,
  styles:[`
    :host{position:relative;display:block;width:100%;height:100%;min-width:0;overflow:hidden;background:#101622}
    video{display:block;width:100%;height:100%;object-fit:contain;background:#101622}
    .ai-canvas{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:4}
    .ai-badge{position:absolute;left:10px;top:10px;z-index:6;padding:4px 8px;border-radius:6px;background:#101828d9;color:#fff;font-size:11px;font-weight:900;letter-spacing:.06em;box-shadow:0 2px 8px #0004}
    .ai-badge.detected{background:#079455eb}
    .vr-badge{position:absolute;left:10px;top:38px;z-index:6;padding:4px 8px;border-radius:6px;background:#0f172ae6;color:#38bdf8;font-size:11px;font-weight:700;display:flex;gap:6px;align-items:center;box-shadow:0 2px 8px #0004}
    .vr-badge.error{background:#7f1d1de6;color:#fca5a5;border:1px solid #ef4444}
    .vr-badge .warn{color:#f87171;background:#7f1d1d80;padding:1px 4px;border-radius:3px}
    .ai-toggle-btn{position:absolute;right:10px;top:10px;z-index:7;padding:3px 7px;border-radius:5px;border:1px solid #ffffff40;background:#101828c0;color:#94a3b8;font-size:10px;font-weight:900;cursor:pointer}
    .ai-toggle-btn.on{background:#4058df;color:#fff;border-color:#7183ff}
    .status{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;padding:8px 11px;border-radius:7px;background:#101828c9;color:#fff;font-size:12px;white-space:nowrap;z-index:5}
  `],
})
export class WebRtcPlayerComponent implements AfterViewInit,OnDestroy{
  @Input({required:true}) cameraId!:string;
  /** HLS is only a deliberate compatibility choice, never a silent WebRTC fallback. */
  @Input() allowHlsFallback=false;
  @Output() fallbackRequested=new EventEmitter<void>();
  @ViewChild("video",{static:true}) video!:ElementRef<HTMLVideoElement>;
  @ViewChild("canvas") canvasRef?:ElementRef<HTMLCanvasElement>;
  status=signal("Подключение WebRTC…");
  showAiOverlay=signal(true);
  peopleCount=signal(0);
  headsetState=signal<any>(null);

  private socket?:Socket;
  private rootSocket?:Socket;
  private peer?:RTCPeerConnection;
  private sessionId="";
  private fallbackSent=false;
  private timeout?:ReturnType<typeof setTimeout>;
  private disconnectTimeout?:ReturnType<typeof setTimeout>;
  private stream=new MediaStream();
  private remoteAnswerAccepted=false;
  private remoteCandidates=new Set<string>();
  private pendingRemoteCandidates:string[]=[];
  private pendingLocalCandidates:string[]=[];
  private offerSignaled=false;
  private silentContext?:AudioContext;
  private silentOscillator?:OscillatorNode;
  private silentTrack?:MediaStreamTrack;
  private latestPeople:Person[]=[];
  private reconnectTimer?:ReturnType<typeof setTimeout>;
  private reconnectAttempt=0;
  private destroyed=false;
  private readonly visibilityHandler=()=>this.handleVisibilityChange();

  ngAfterViewInit(){
    document.addEventListener("visibilitychange",this.visibilityHandler);
    this.connect();
  }

  private connect(){
    if(this.destroyed||document.visibilityState!=="visible")return;
    this.fallbackSent=false;
    this.status.set("Подключение WebRTC…");
    // Access tokens are intentionally session-scoped. Reading a legacy localStorage
    // key left the signaling namespace unauthenticated and made every player fall
    // back to HLS even when the Tuya device supported WebRTC.
    const token=sessionStorage.getItem("access_token")||"";
    // Root socket for realtime AI updates
    try{
      this.rootSocket=io({path:"/socket.io",transports:["websocket"],auth:{token}});
      this.rootSocket.on("camera:ai:state",(st:any)=>{
        if(st?.cameraId===this.cameraId){
          this.peopleCount.set(Number(st.peopleCount||0));
          if(Array.isArray(st.people)){
            this.latestPeople=st.people;
            this.drawOverlay();
          }
        }
      });
      this.rootSocket.on("camera:headset:state",(st:any)=>{
        if(st?.cameraId===this.cameraId){
          this.headsetState.set(st);
          this.drawOverlay();
        }
      });
    }catch{}

    this.socket=io("/webrtc",{path:"/socket.io",auth:{token},transports:["websocket"],timeout:10_000,reconnection:false});
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

  private handleVisibilityChange(){
    if(this.destroyed)return;
    if(document.visibilityState==="hidden"){
      // Mobile/desktop browsers suspend WebSockets and WebRTC while hidden.
      // Explicitly release Tuya's P2P slot; reconnecting the old peer after a
      // long pause is unreliable and caused the permanent "websocket error".
      this.cleanup();
      return;
    }
    this.reconnectAttempt=0;
    this.scheduleReconnect(150);
  }

  private scheduleReconnect(delay?:number){
    if(this.destroyed||this.allowHlsFallback||document.visibilityState!=="visible"||this.reconnectTimer)return;
    const retryDelay=delay ?? Math.min(12_000,1_000*(2**Math.min(this.reconnectAttempt,4)));
    this.reconnectTimer=setTimeout(()=>{
      this.reconnectTimer=undefined;
      if(this.destroyed||document.visibilityState!=="visible")return;
      this.cleanup();
      this.stream=new MediaStream();
      this.reconnectAttempt+=1;
      this.connect();
    },retryDelay);
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
      // Browser WebRTC exposes a raw candidate (`candidate:…`). The backend
      // converts it to Tuya MQTT's required SDP-line form (`a=candidate:…`).
      // Do not send an empty end-of-candidates marker.
      this.peer.onicecandidate=event=>{
        const candidate=event.candidate?.candidate;
        if(!candidate)return;
        // Tuya requires the offer before any trickled candidates. Candidate
        // gathering can start inside setLocalDescription(), so buffer until
        // the offer has been placed on the signaling channel.
        if(!this.offerSignaled)this.pendingLocalCandidates.push(candidate);
        else this.send("candidate",candidate);
      };
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
      // The remote answer must be generated from the exact SDP the browser has
      // installed locally. Rewriting it after setLocalDescription can make Chrome
      // reject an otherwise valid Tuya answer.
      const offerAccepted=await this.send("offer",this.peer.localDescription?.sdp||offer.sdp||"");
      if(!offerAccepted)return;
      this.offerSignaled=true;
      for(const candidate of this.pendingLocalCandidates.splice(0))void this.send("candidate",candidate);
    }catch(error){this.fallback("peer-error",error instanceof Error?error.message:String(error))}
  }

  private async onSignal(message:SignalMessage){
    if(message.sessionId!==this.sessionId||!this.peer)return;
    try{
      if(message.type==="answer"){
        if(this.remoteAnswerAccepted||this.peer.signalingState!=="have-local-offer"){this.diagnostic("duplicate-answer",this.peer.signalingState);return}
        this.remoteAnswerAccepted=true;
        this.diagnostic("camera-answer");
        await this.peer.setRemoteDescription({type:"answer",sdp:message.payload});
        const pending=this.pendingRemoteCandidates.splice(0);
        for(const candidate of pending)await this.addRemoteCandidate(candidate);
      }
      else if(message.type==="candidate"&&message.payload){
        // Tuya may trickle an ICE candidate before the answer. Browser WebRTC
        // rejects addIceCandidate until setRemoteDescription has completed, so
        // retain the candidate and apply it immediately afterwards.
        if(!this.peer.remoteDescription){
          if(!this.pendingRemoteCandidates.includes(message.payload))this.pendingRemoteCandidates.push(message.payload);
          this.diagnostic("candidate-buffered");
          return;
        }
        await this.addRemoteCandidate(message.payload);
      }
      else if(message.type==="disconnect")this.fallback("camera-disconnect");
    }catch(error){this.fallback("signal-error",error instanceof Error?error.message:String(error))}
  }

  private async addRemoteCandidate(candidate:string){
    if(!this.peer||this.remoteCandidates.has(candidate))return;
    this.remoteCandidates.add(candidate);
    try{
      await this.peer.addIceCandidate({candidate,sdpMid:"0",sdpMLineIndex:0});
    }catch(error){
      // One malformed/obsolete trickle candidate must not terminate a session;
      // the remaining candidates and connection timeout still decide the result.
      this.diagnostic("candidate-rejected",error instanceof Error?error.message:String(error));
    }
  }

  private send(type:"offer"|"candidate"|"disconnect",payload:string):Promise<boolean>{
    if(!this.socket?.connected||!this.sessionId)return Promise.resolve(false);
    return new Promise(resolve=>this.socket?.emit("signal",{sessionId:this.sessionId,type,payload},(result:{success?:boolean;error?:string}|undefined)=>{
      if(result?.success===false){this.fallback("signal-rejected",result.error||type);resolve(false);}
      else resolve(true);
    }));
  }

  private diagnostic(stage:string,detail=""){this.socket?.emit("diagnostic",{cameraId:this.cameraId,stage,detail:detail.slice(0,160)})}

  private fallback(stage:string,detail=""){
    if(this.fallbackSent)return;
    this.diagnostic(stage,detail);
    this.fallbackSent=true;this.cleanup();
    this.status.set(`WebRTC недоступен${detail?`: ${detail}`:""}`);
    // Falling back to HLS masked signaling failures and contradicted the selected
    // transport. It remains possible only where a caller asks for it explicitly.
    if(this.allowHlsFallback)this.fallbackRequested.emit();
    else this.scheduleReconnect();
  }

  toggleOverlay(event:Event){
    event.stopPropagation();
    this.showAiOverlay.set(!this.showAiOverlay());
    if(this.showAiOverlay()){
      setTimeout(()=>this.drawOverlay(),50);
    }
  }

  onResize(){
    this.drawOverlay();
  }

  private drawOverlay(){
    if(!this.showAiOverlay()||!this.canvasRef)return;
    const canvas=this.canvasRef.nativeElement;
    const v=this.video?.nativeElement;
    if(!canvas||!v)return;

    const w=v.clientWidth;
    const h=v.clientHeight;
    if(!w||!h)return;

    if(canvas.width!==w||canvas.height!==h){
      canvas.width=w;
      canvas.height=h;
    }

    const ctx=canvas.getContext("2d");
    if(!ctx)return;
    ctx.clearRect(0,0,w,h);

    // Calculate aspect-ratio fit rect inside video element
    const vw=v.videoWidth||w;
    const vh=v.videoHeight||h;
    const scale=Math.min(w/vw,h/vh);
    const renderW=vw*scale;
    const renderH=vh*scale;
    const offsetX=(w-renderW)/2;
    const offsetY=(h-renderH)/2;

    // 1. Draw VR Headset Zones & Detections
    const hs = this.headsetState();
    if(hs?.assignedZonesState){
      for(const zone of Object.values(hs.assignedZonesState) as any[]){
        if(zone.status === "NOT_VISIBLE") continue;

        if(zone.bbox){
          const bx = offsetX + (zone.bbox.x * renderW);
          const by = offsetY + (zone.bbox.y * renderH);
          const bw = zone.bbox.width * renderW;
          const bh = zone.bbox.height * renderH;

          ctx.lineWidth = 2;
          if(zone.status === "UNKNOWN"){
            ctx.strokeStyle = "#eab308";
            ctx.setLineDash([4, 4]);
          } else if(zone.status === "OCCUPIED"){
            ctx.strokeStyle = zone.type === "WORK_ZONE" ? "#f97316" : "#10b981";
            ctx.setLineDash([]);
          } else {
            ctx.strokeStyle = "#94a3b8";
            ctx.setLineDash([]);
          }

          ctx.strokeRect(bx, by, bw, bh);
          ctx.setLineDash([]);

          const label = zone.type === "WORK_ZONE" && zone.status === "OCCUPIED"
            ? `VR: ${zone.headsetId || zone.name} (НЕ НА БАЗЕ)`
            : `VR: ${zone.headsetId || zone.name} (${zone.status})`;
          const textWidth = ctx.measureText(label).width;
          ctx.fillStyle = zone.status === "OCCUPIED"
            ? (zone.type === "WORK_ZONE" ? "#ea580ce6" : "#10b981e6")
            : (zone.status === "UNKNOWN" ? "#ca8a04e6" : "#475569e6");
          ctx.fillRect(bx, Math.max(0, by - 18), textWidth + 8, 18);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(label, bx + 4, Math.max(12, by - 4));
        }
      }
    }

    // 2. Draw People Detection Boxes
    if(!this.latestPeople?.length)return;

    ctx.lineWidth=2.5;
    ctx.strokeStyle="#10b981";
    ctx.font="bold 11px Poppins, sans-serif";

    for(const p of this.latestPeople){
      const bx=offsetX+(p.bbox.x*renderW);
      const by=offsetY+(p.bbox.y*renderH);
      const bw=p.bbox.width*renderW;
      const bh=p.bbox.height*renderH;

      // Box
      ctx.strokeRect(bx,by,bw,bh);

      // Label background
      const label=p.trackId?`#${p.trackId} ${Math.round(p.confidence*100)}%`:`${Math.round(p.confidence*100)}%`;
      const textWidth=ctx.measureText(label).width;
      ctx.fillStyle="#10b981e6";
      ctx.fillRect(bx,Math.max(0,by-18),textWidth+8,18);

      // Label text
      ctx.fillStyle="#ffffff";
      ctx.fillText(label,bx+4,Math.max(12,by-4));
    }
  }

  private cleanup(){
    if(this.timeout)clearTimeout(this.timeout);
    if(this.disconnectTimeout)clearTimeout(this.disconnectTimeout);
    this.timeout=undefined;this.disconnectTimeout=undefined;
    if(this.sessionId)this.send("disconnect","");
    this.peer?.close();this.socket?.disconnect();
    this.rootSocket?.disconnect();
    this.peer=undefined;this.socket=undefined;this.rootSocket=undefined;
    this.remoteAnswerAccepted=false;
    this.remoteCandidates.clear();
    this.pendingRemoteCandidates=[];
    this.silentTrack?.stop();this.silentOscillator?.stop();void this.silentContext?.close();
    this.silentTrack=undefined;this.silentOscillator=undefined;this.silentContext=undefined;
    for(const track of this.stream.getTracks())track.stop();
  }

  ngOnDestroy(){
    this.destroyed=true;
    document.removeEventListener("visibilitychange",this.visibilityHandler);
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    this.cleanup();
  }
}
