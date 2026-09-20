import { Component, HostListener, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { DatePipe } from "@angular/common";
import { DomSanitizer, SafeResourceUrl } from "@angular/platform-browser";
import { io, Socket } from "socket.io-client";
import { HlsPlayerComponent } from "../pages/cameras/hls-player.component";
import { WebRtcPlayerComponent } from "../pages/cameras/webrtc-player.component";

type Camera={id:string;room_id?:string|null;name:string;room_name:string|null;provider:string;config?:{source?:string};tracking_enabled?:boolean;ai_enabled?:boolean};
type Player={mode:"hls"|"player"|"webrtc";endpoint?:string;safeEndpoint?:SafeResourceUrl};
type NightMode="auto"|"on"|"off";
type AIState={peopleCount:number;occupied:boolean;motion:boolean;description?:string;lastUpdated?:string};
type AIEvent={id:string;type:string;timestamp:string;peopleCount:number;confidence:number;description?:string};

@Component({
  selector:"app-camera-overlay",standalone:true,imports:[DatePipe,HlsPlayerComponent,WebRtcPlayerComponent],
  template:`
    @if(selected().length){
      <section class="watch" [class.collapsed]="collapsed()" [class.single]="selected().length===1">
        @if(collapsed()){<button class="collapsed-bar" (click)="collapsed.set(false)"><span class="camera-icon">●</span><strong>Развернуть</strong><i class="expand-arrow">⌃</i></button>}
        @else{
          <button class="collapse-arrow" title="Свернуть" (click)="collapsed.set(true)"><span></span></button>
          <div class="grid">
            @for(camera of selected();track camera.id){
              <article [class.active-camera]="activeCameraId()===camera.id" (click)="selectCamera(camera)">
                <div class="video">
                  @if(players()[camera.id];as player){
                    @if(player.mode==="webrtc"){<app-webrtc-player [cameraId]="camera.id" (fallbackRequested)="fallback(camera)"/>}
                    @else if(player.mode==="hls"){<app-hls-player [url]="player.endpoint!"/>}
                    @else{<iframe [src]="player.safeEndpoint!" [title]="camera.name" allow="autoplay; fullscreen"></iframe>}
                  }@else{<button (click)="open(camera)">▶ Открыть</button>}
                  @if(camera.provider==="TUYA"){
                    <button class="night-toggle" [class.on]="nightModes()[camera.id]==='on'" [title]="nightModes()[camera.id]==='on'?'Выключить ночное видение':'Включить ночное видение'" (click)="toggleNightVision($event,camera)">☾</button>
                  }
                </div>
                <footer>
                  <div>
                    <b>{{camera.name}}</b>
                    <small>{{camera.room_name||"Без комнаты"}}</small>
                  </div>
                  <div class="ai-chips">
                    <span class="chip people" [class.active]="(aiStates()[camera.id]?.peopleCount||0)>0">
                      👥 {{aiStates()[camera.id]?.peopleCount||0}}
                    </span>
                    <span class="chip" [class.occupied]="aiStates()[camera.id]?.occupied">
                      {{aiStates()[camera.id]?.occupied?'Занято':'Свободно'}}
                    </span>
                    @if(aiStates()[camera.id]?.motion){
                      <span class="chip motion">Движение</span>
                    }
                    @if(headsetStates()[camera.id]; as hs){
                      @if(hs.modelStatus === 'MODEL_UNAVAILABLE' || hs.status === 'MODEL_UNAVAILABLE'){
                        <span class="chip vr-error" title="VR модель недоступна">
                          ⚠️ VR недоступна
                        </span>
                      } @else {
                        <span class="chip vr" [class.warn]="(hs.notOnBaseCount ?? hs.outsideZoneCount) > 0" [title]="'На базе: ' + (hs.onChargingBaseCount ?? hs.chargingBaseCount) + ', не на базе: ' + (hs.notOnBaseCount ?? hs.outsideZoneCount) + (hs.notOnBaseHeadsets?.length ? ' (в квадратах: ' + hs.notOnBaseHeadsets.join(', ') + ')' : '')">
                          🥽 {{hs.totalDetected}}
                        </span>
                      }
                    }
                  </div>
                  @if(ptzEnabled(camera)&&activeCameraId()===camera.id){<em>⌨ Стрелки</em>}
                </footer>
                @if(aiDescriptions()[camera.id]){
                  <div class="ai-summary">
                    <small>AI VLM:</small>
                    <p>{{aiDescriptions()[camera.id]}}</p>
                  </div>
                }
                @if(controlErrors()[camera.id]){<p class="control-error">{{controlErrors()[camera.id]}}</p>}
              </article>
            }
          </div>
        }
      </section>
    }
    @if(eventsCameraId()){
      <div class="ai-modal-backdrop" (click)="closeEvents()">
        <section class="ai-modal" (click)="$event.stopPropagation()">
          <header>
            <h3>История AI событий</h3>
            <button class="close-btn" (click)="closeEvents()">×</button>
          </header>
          <div class="events-list">
            @for(ev of cameraEvents();track ev.id){
              <div class="event-item">
                <time>{{ev.timestamp|date:'HH:mm:ss'}}</time>
                <span class="event-type">{{ev.type}}</span>
                <p>{{ev.description||'—'}}</p>
                <b>Людей: {{ev.peopleCount}}</b>
              </div>
            }@empty{
              <p class="empty-events">Событий пока не зафиксировано.</p>
            }
          </div>
        </section>
      </div>
    }
  `,
  styles:[`
    .watch{position:fixed;z-index:900;right:20px;bottom:20px;width:min(860px,calc(100vw - 40px));max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow:auto;border:1px solid #d5dae5;border-radius:16px;background:#fff;box-shadow:0 20px 60px #10182845}
    .watch.single:not(.collapsed){width:min(600px,calc(100vw - 40px))}
    .watch button{padding:7px 9px;background:#29344a;color:#fff;box-shadow:none;white-space:nowrap}
    .collapse-arrow{position:absolute;z-index:8;top:6px;right:6px;display:grid;place-items:center;width:26px;height:26px;padding:0!important;border:1px solid #d0d5dd!important;border-radius:7px!important;background:#fffffff0!important;box-shadow:0 2px 8px #10182824!important}
    .collapse-arrow:hover{background:#fff!important}
    .collapse-arrow span{width:7px;height:7px;margin-top:-3px;border-right:2px solid #344054;border-bottom:2px solid #344054;transform:rotate(45deg)}
    .watch.collapsed{width:230px;max-height:none;overflow:hidden;border:1px solid #d9deea;background:#fff}
    .collapsed-bar{display:grid!important;grid-template-columns:28px 1fr auto;align-items:center;gap:8px;width:100%;padding:8px 10px!important;border-radius:14px!important;background:#fff!important;color:#111827!important;text-align:left}
    .collapsed-bar:hover{background:#f8f9fc!important}
    .collapsed-bar .camera-icon{display:grid;place-items:center;width:26px;height:26px;border-radius:50%;background:#4058df;color:#fff;font-size:9px}
    .collapsed-bar strong{justify-self:end;font-size:12px;color:#111827}
    .expand-arrow{font-size:18px;font-style:normal;color:#4058df;line-height:1}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:100%;min-width:0;overflow:hidden;gap:1px;background:#d8dce5}
    .single .grid{grid-template-columns:1fr}
    .grid article{width:100%;min-width:0;max-width:100%;overflow:hidden;background:#fff;box-shadow:inset 0 0 0 2px transparent;cursor:pointer}
    .grid article.active-camera{box-shadow:inset 0 0 0 2px #6172f3}
    .video{position:relative;display:grid;place-items:center;width:100%;min-width:0;max-width:100%;overflow:hidden;aspect-ratio:16/9;background:#101622}
    .video iframe,.video app-hls-player,.video app-webrtc-player{display:block;width:100%;min-width:0;max-width:100%;height:100%;border:0}
    .video>button:not(.night-toggle){background:#29344a}
    .night-toggle{position:absolute;z-index:7;top:7px;right:39px;display:grid!important;place-items:center;width:28px;height:28px;padding:0!important;border:1px solid #d0d5dd!important;border-radius:8px!important;background:#fffffff0!important;color:#344054!important;font-size:17px;line-height:1;box-shadow:0 2px 8px #10182824!important}
    .night-toggle.on{border-color:#8098f9!important;background:#444ce7ed!important;color:#fff!important}
    .grid footer{display:flex;justify-content:space-between;align-items:center;gap:8px;min-width:0;padding:8px 10px;border-bottom:1px solid #f1f3f7}
    .grid footer b,.grid footer small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .grid footer small{margin-top:2px;color:#7b8495;font-size:9px}
    .grid footer em{padding:4px 7px;border-radius:6px;background:#eef1ff;color:#4058df;font-size:9px;font-style:normal;font-weight:800}
    .ai-chips{display:flex;gap:5px;align-items:center}
    .chip{padding:3px 6px;border-radius:4px;background:#f2f4f7;color:#475467;font-size:10px;font-weight:800}
    .chip.people.active{background:#ecfdf3;color:#027a48}
    .chip.occupied{background:#fef3f2;color:#b42318}
    .chip.motion{background:#eff8ff;color:#175cd3}
    .chip.vr{background:#e0f2fe;color:#0369a1}
    .chip.vr.warn{background:#fef2f2;color:#b91c1c}
    .chip.vr-error{background:#fee2e2;color:#991b1b;border:1px solid #f87171}
    .ai-summary{padding:6px 10px;background:#f8f9fc;border-bottom:1px solid #eef0f4;font-size:11px}
    .ai-summary small{display:block;color:#667085;font-size:9px;font-weight:900}
    .ai-summary p{margin:2px 0 0;color:#1e293b;line-height:1.3}
    .ai-actions{display:flex;flex-wrap:wrap;gap:5px;padding:6px 10px;background:#fff}
    .ai-btn{padding:4px 8px!important;border:1px solid #d0d5dd!important;border-radius:6px!important;background:#fff!important;color:#344054!important;font-size:10px!important;font-weight:700}
    .ai-btn:hover{background:#f8f9fc!important}
    .ai-btn.active-tracking{background:#4058df!important;color:#fff!important;border-color:#4058df!important}
    .control-error{margin:0;padding:0 10px 7px;color:#b42318;font-size:10px}
    .ai-modal-backdrop{position:fixed;z-index:1200;inset:0;display:grid;place-items:center;padding:20px;background:#10182899;backdrop-filter:blur(4px)}
    .ai-modal{display:grid;width:min(500px,100%);max-height:80vh;border-radius:14px;background:#fff;box-shadow:0 30px 80px #0006;overflow:hidden}
    .ai-modal header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;border-bottom:1px solid #eef0f4}
    .ai-modal header h3{margin:0;font-size:16px}
    .close-btn{padding:2px 8px;border:0;background:transparent;color:#667085;font-size:20px;cursor:pointer}
    .events-list{overflow-y:auto;padding:12px 18px;display:grid;gap:8px}
    .event-item{display:grid;grid-template-columns:65px auto;gap:6px;padding:8px 10px;border-radius:8px;background:#f8f9fc;border:1px solid #eef0f4;font-size:11px}
    .event-item time{color:#64748b}
    .event-type{font-weight:800;color:#4058df}
    .event-item p{grid-column:1/-1;margin:2px 0 0;color:#1e293b}
    .event-item b{grid-column:1/-1;color:#027a48;font-size:10px}
    .empty-events{padding:20px;text-align:center;color:#64748b}
  `]
})
export class CameraOverlayComponent{
  private http=inject(HttpClient);private sanitizer=inject(DomSanitizer);
  cameras=signal<Camera[]>([]);selectedIds=signal<string[]>([]);players=signal<Record<string,Player>>({});collapsed=signal(false);
  nightModes=signal<Record<string,NightMode>>({});controlErrors=signal<Record<string,string>>({});activeCameraId=signal<string|null>(null);
  aiStates=signal<Record<string,AIState>>({});
  headsetStates=signal<Record<string,any>>({});
  trackingStates=signal<Record<string,boolean>>({});
  analyzing=signal<Record<string,boolean>>({});
  inspecting=signal<Record<string,boolean>>({});
  inspectingVr=signal<Record<string,boolean>>({});
  aiDescriptions=signal<Record<string,string>>({});
  eventsCameraId=signal<string|null>(null);
  cameraEvents=signal<AIEvent[]>([]);

  private activePtz=new Set<string>();
  private rootSocket?:Socket;

  constructor(){
    this.reload();
    this.connectSocket();
  }

  private connectSocket(){
    const token=sessionStorage.getItem("access_token");
    if(!token)return;
    try{
      this.rootSocket=io({path:"/socket.io",transports:["websocket"],auth:{token}});
      this.rootSocket.on("camera:ai:state",(st:any)=>{
        if(st?.cameraId){
          this.aiStates.update(v=>({...v,[st.cameraId]:{
            peopleCount:Number(st.peopleCount||0),
            occupied:Boolean(st.occupied),
            motion:Boolean(st.motion),
            lastUpdated:st.lastUpdated
          }}));
        }
      });
      this.rootSocket.on("camera:headset:state",(st:any)=>{
        if(st?.cameraId){
          this.headsetStates.update(v=>({...v,[st.cameraId]:st}));
        }
      });
    }catch{}
  }

  @HostListener("window:questcontrol-camera-selection") selectionChanged(){this.reload()}
  reload(){
    if(!sessionStorage.getItem("access_token"))return;
    this.http.get<Camera[]>("/api/cameras").subscribe({next:c=>{
      this.cameras.set(c);
      const trackingMap:Record<string,boolean>={};
      for(const cam of c){
        if(cam.tracking_enabled) trackingMap[cam.id]=true;
      }
      this.trackingStates.set(trackingMap);
      this.readSelection();
    }});
  }

  readSelection(){
    try{
      const ids=JSON.parse(localStorage.getItem("questcontrol.selectedCameras")||"[]");
      this.selectedIds.set(Array.isArray(ids)?ids:[]);
      const selected=this.selected();
      if(!selected.some(camera=>camera.id===this.activeCameraId()))this.activeCameraId.set(selected.find(camera=>camera.provider==="TUYA")?.id||selected[0]?.id||null);
      for(const camera of selected){
        if(!this.players()[camera.id])this.open(camera);
        this.fetchAiState(camera.id);
      }
    }catch{this.selectedIds.set([])}
  }

  fetchAiState(cameraId:string){
    this.http.get<AIState>(`/api/cameras/${cameraId}/ai/state`).subscribe({
      next:st=>{
        if(st) this.aiStates.update(v=>({...v,[cameraId]:st}));
      },
      error:()=>{}
    });
  }

  selected(){const ids=new Set(this.selectedIds());return this.cameras().filter(c=>ids.has(c.id))}
  open(camera:Camera,transport:"webrtc"|"hls"="webrtc"){
    const query=transport==="hls"?"?transport=hls":"";
    this.http.get<{endpoint?:string;mode:"hls"|"player"|"webrtc"}>(`/api/cameras/${camera.id}/stream${query}`).subscribe({
      next:p=>this.players.update(v=>({...v,[camera.id]:{...p,safeEndpoint:p.mode==="player"?this.sanitizer.bypassSecurityTrustResourceUrl(p.endpoint!):undefined}}))
    });
  }
  fallback(camera:Camera){this.players.update(v=>{const next={...v};delete next[camera.id];return next});this.open(camera,"hls")}
  selectCamera(camera:Camera){if(this.activeCameraId()===camera.id)return;this.stopAllPtz();this.activeCameraId.set(camera.id)}

  ptzEnabled(camera:Camera){return camera.provider==="TUYA"||camera.config?.source==="TUYA_LAN_BRIDGE"}
  @HostListener("document:keydown",["$event"]) keyDown(event:KeyboardEvent){const direction=({ArrowUp:"UP",ArrowRight:"RIGHT",ArrowDown:"DOWN",ArrowLeft:"LEFT"} as const)[event.key as "ArrowUp"|"ArrowRight"|"ArrowDown"|"ArrowLeft"];if(!direction||event.repeat||this.isEditing(event.target))return;const camera=this.selected().find(item=>item.id===this.activeCameraId()&&this.ptzEnabled(item));if(!camera)return;event.preventDefault();this.activePtz.add(camera.id);this.control(camera,{action:"ptz",direction})}
  @HostListener("document:keyup",["$event"]) keyUp(event:KeyboardEvent){if(!event.key.startsWith("Arrow")||this.isEditing(event.target))return;const camera=this.selected().find(item=>item.id===this.activeCameraId());if(camera){event.preventDefault();this.stopPtz(camera)}}
  @HostListener("window:blur") stopAllPtz(){for(const id of [...this.activePtz]){const camera=this.cameras().find(item=>item.id===id);if(camera)this.stopPtz(camera)}}
  private isEditing(target:EventTarget|null){return target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement||(target instanceof HTMLElement&&target.isContentEditable)}
  stopPtz(camera:Camera){if(!this.activePtz.delete(camera.id))return;this.control(camera,{action:"ptz",direction:"STOP"})}
  toggleNightVision(event:Event,camera:Camera){event.stopPropagation();const mode:NightMode=this.nightModes()[camera.id]==="on"?"off":"on";this.control(camera,{action:"nightVision",mode},()=>this.nightModes.update(v=>({...v,[camera.id]:mode})))}

  analyzeNow(camera:Camera){
    this.analyzing.update(v=>({...v,[camera.id]:true}));
    this.http.post<any>(`/api/cameras/${camera.id}/ai/analyze`,{question:"Determine what happened during these frames."}).subscribe({
      next:res=>{
        this.analyzing.update(v=>({...v,[camera.id]:false}));
        if(res?.description){
          this.aiDescriptions.update(v=>({...v,[camera.id]:res.description}));
        }
      },
      error:()=>{this.analyzing.update(v=>({...v,[camera.id]:false}))}
    });
  }

  inspectRoom(camera:Camera){
    if(!camera.room_id)return;
    this.inspecting.update(v=>({...v,[camera.id]:true}));
    this.http.post<any>(`/api/rooms/${camera.room_id}/ai/inspect`,{}).subscribe({
      next:res=>{
        this.inspecting.update(v=>({...v,[camera.id]:false}));
        if(res?.summary){
          this.aiDescriptions.update(v=>({...v,[camera.id]:res.summary}));
        }
      },
      error:()=>{this.inspecting.update(v=>({...v,[camera.id]:false}))}
    });
  }

  inspectVr(camera:Camera){
    if(!camera.room_id)return;
    this.inspectingVr.update(v=>({...v,[camera.id]:true}));
    this.http.post<any>(`/api/rooms/${camera.room_id}/headset/inspect`,{}).subscribe({
      next:res=>{
        this.inspectingVr.update(v=>({...v,[camera.id]:false}));
        if(res?.summary){
          this.aiDescriptions.update(v=>({...v,[camera.id]:res.summary}));
        }
      },
      error:err=>{
        this.inspectingVr.update(v=>({...v,[camera.id]:false}));
        const msg = err.error?.message || "Ошибка VR осмотра";
        this.controlErrors.update(v=>({...v,[camera.id]:msg}));
      }
    });
  }

  toggleTracking(camera:Camera){
    const next=!this.trackingStates()[camera.id];
    this.http.patch<any>(`/api/cameras/${camera.id}/ai/settings`,{trackingEnabled:next}).subscribe({
      next:()=>{
        this.trackingStates.update(v=>({...v,[camera.id]:next}));
      }
    });
  }

  openEvents(camera:Camera){
    this.eventsCameraId.set(camera.id);
    this.http.get<AIEvent[]>(`/api/cameras/${camera.id}/ai/events`).subscribe({
      next:ev=>this.cameraEvents.set(ev),
      error:()=>this.cameraEvents.set([])
    });
  }

  closeEvents(){
    this.eventsCameraId.set(null);
    this.cameraEvents.set([]);
  }

  private control(camera:Camera,body:unknown,onSuccess=()=>{}){this.controlErrors.update(v=>{const next={...v};delete next[camera.id];return next});this.http.post(`/api/cameras/${camera.id}/control`,body).subscribe({next:onSuccess,error:({error})=>this.controlErrors.update(v=>({...v,[camera.id]:error?.message||"Команда не поддерживается этой камерой"}))})}
  remove(id:string){this.selectedIds.update(ids=>ids.filter(value=>value!==id));this.persist();this.players.update(v=>{const next={...v};delete next[id];return next})}
  clear(){this.selectedIds.set([]);this.players.set({});this.persist()}
  persist(){localStorage.setItem("questcontrol.selectedCameras",JSON.stringify(this.selectedIds()));window.dispatchEvent(new Event("questcontrol-camera-selection"))}
}
