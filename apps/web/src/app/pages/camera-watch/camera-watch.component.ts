import { Component, OnDestroy, inject, signal } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { HttpClient } from "@angular/common/http";
import { DomSanitizer, SafeResourceUrl } from "@angular/platform-browser";
import { WebRtcPlayerComponent } from "../cameras/webrtc-player.component";
import { HlsPlayerComponent } from "../cameras/hls-player.component";

type Camera={id:string;name:string;room_name:string|null;status:string;provider:string};
type Player={mode:"hls"|"player"|"webrtc";endpoint?:string;safeEndpoint?:SafeResourceUrl};

@Component({selector:"app-camera-watch",standalone:true,imports:[WebRtcPlayerComponent,HlsPlayerComponent],template:`
<main class="watch-page">
  <header class="watch-header">
    <div class="brand-mark">Q</div>
    <div class="headline"><span class="eyebrow">QUEST CONTROL · GUEST ACCESS</span><h1>Location cameras</h1></div>
    <div class="secure"><span>●</span><b>Secure view</b></div>
  </header>
  @if(error()){<section class="state error"><span>!</span><h2>Access unavailable</h2><p>{{error()}}</p></section>}
  @else if(loading()){<section class="state"><span class="spinner"></span><h2>Connecting cameras</h2></section>}
  @else{
    <section class="grid" [class.single]="cameras().length===1" [class.two]="cameras().length===2">
      @for(camera of cameras();track camera.id){
        <article>
          <div class="video">
            @if(players()[camera.id];as player){
              @if(player.mode==='player'){<iframe [src]="player.safeEndpoint!" [title]="camera.name" allow="autoplay; fullscreen; picture-in-picture"></iframe>}
              @else if(player.mode==='webrtc'){<app-webrtc-player [cameraId]="camera.id" [allowHlsFallback]="true" [minimal]="true" (fallbackRequested)="fallback(camera)"/>}
              @else if(player.endpoint){<app-hls-player [url]="player.endpoint"/>}
            }@else if(streamErrors()[camera.id];as streamError){
              <div class="video-error"><span>!</span><b>Unable to load video</b><small>{{streamError}}</small><button type="button" (click)="open(camera)">Retry</button></div>
            }@else{
              <div class="video-loading"><span class="spinner"></span><p>Connecting…</p></div>
            }
          </div>
        </article>
      }@empty{<section class="state empty-list"><h2>No cameras selected</h2><p>Ask an administrator to create a new guest link.</p></section>}
    </section>
  }
</main>
`,styles:[`
:host{display:block;height:100svh;background:#090d16}.watch-page{display:grid;grid-template-rows:auto minmax(0,1fr);gap:10px;height:100svh;padding:10px;color:#edf2ff;overflow:hidden;background:radial-gradient(circle at 85% -10%,#5865e842,transparent 30%),radial-gradient(circle at 4% 100%,#11b98118,transparent 34%),#090d16;font-family:Inter,system-ui,sans-serif}.watch-header{display:flex;align-items:center;gap:12px;width:100%;padding:10px 13px;border:1px solid #ffffff16;border-radius:14px;background:#111827bb;box-shadow:0 10px 26px #0004;backdrop-filter:blur(14px)}.brand-mark{display:grid;flex:none;width:40px;height:40px;place-items:center;border-radius:11px;background:linear-gradient(135deg,#7883ff,#4855d8);box-shadow:0 7px 18px #5360df55;font-size:22px;font-weight:900}.headline{min-width:0}.eyebrow{color:#9ba8ff;font-size:9px;font-weight:800;letter-spacing:.13em}.headline h1{margin:2px 0 0;font-size:clamp(18px,2vw,24px);letter-spacing:-.04em}.secure{display:flex;align-items:center;gap:7px;margin-left:auto;padding:7px 10px;border:1px solid #2b7b63;border-radius:10px;background:#0b2b27a8;color:#b5f5dc}.secure>span{color:#36d28f;font-size:18px;line-height:1}.secure b{font-size:10px}.video-error button{border:1px solid #6472f4;border-radius:8px;background:#4f5bd9;color:#fff;padding:7px 10px;font:inherit;font-size:10px;font-weight:800;cursor:pointer;box-shadow:0 4px 12px #3f4ac044}.video-error button:hover{background:#6572f4}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(260px,1fr);gap:10px;width:100%;height:100%;min-height:0;overflow:auto}.grid.single{grid-template-columns:1fr;grid-template-rows:1fr;overflow:hidden}.grid.two{grid-template-rows:1fr;overflow:hidden}.grid article{min-width:0;min-height:0;overflow:hidden;border:1px solid #ffffff16;border-radius:13px;background:#03060b;box-shadow:0 12px 28px #0004}.video{display:grid;position:relative;width:100%;height:100%;min-height:0;overflow:hidden;place-items:center;background:#03060b}.video iframe,.video app-webrtc-player,.video app-hls-player{display:block;width:100%;height:100%;border:0}.video-loading,.video-error{display:grid;place-items:center;gap:8px;padding:20px;text-align:center;color:#aeb9cb}.video-loading p{margin:0;font-size:11px}.spinner{display:block;width:22px;height:22px;border:2px solid #6572f444;border-top-color:#8b95ff;border-radius:50%;animation:spin .8s linear infinite}.video-error>span{display:grid;width:27px;height:27px;place-items:center;border-radius:50%;background:#512435;color:#ffbdc8;font-weight:900}.video-error b{color:#eef2ff;font-size:12px}.video-error small{max-width:320px;color:#8f9bae;font-size:10px}.state{display:grid;place-items:center;align-content:center;min-height:0;height:100%;max-width:620px;margin:auto;padding:30px;text-align:center;color:#aeb9cb}.state h2{margin:12px 0 4px;color:#f1f5ff;font-size:20px}.state p{margin:0;font-size:12px;line-height:1.5}.state.error>span{display:grid;width:45px;height:45px;place-items:center;border-radius:15px;background:#512435;color:#ffbdc8;font-size:22px;font-weight:900}.empty-list{grid-column:1/-1;min-height:260px}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:640px){.watch-page{padding:7px;gap:7px}.watch-header{padding:8px 10px;gap:9px;border-radius:11px}.brand-mark{width:35px;height:35px;border-radius:9px;font-size:19px}.secure{display:none}.grid{grid-template-columns:1fr;gap:7px}.grid.two{grid-template-rows:repeat(2,minmax(0,1fr))}.grid article{border-radius:10px}}
`]})
export class CameraWatchComponent implements OnDestroy{
  private http=inject(HttpClient);private route=inject(ActivatedRoute);private sanitizer=inject(DomSanitizer);private timer?:number;
  cameras=signal<Camera[]>([]);players=signal<Record<string,Player>>({});streamErrors=signal<Record<string,string>>({});loading=signal(true);error=signal("");
  constructor(){this.connect()}
  connect(){const token=this.route.snapshot.paramMap.get("token");if(!token){this.loading.set(false);this.error.set("Invalid guest link.");return}this.http.post<{accessToken:string}>(`/api/camera-shares/${encodeURIComponent(token)}/access`,{}).subscribe({next:value=>{sessionStorage.setItem("access_token",value.accessToken);this.load();this.timer=window.setTimeout(()=>this.connect(),10*60_000)},error:()=>{this.loading.set(false);this.error.set("This link has expired or was revoked.")}})}
  load(){this.http.get<Camera[]>("/api/cameras").subscribe({next:value=>{this.cameras.set(value);this.loading.set(false);this.reloadPlayers()},error:()=>{this.loading.set(false);this.error.set("Unable to connect to the camera streams.")}})}
  reloadPlayers(){this.players.set({});this.streamErrors.set({});for(const camera of this.cameras())this.open(camera)}
  open(camera:Camera){this.streamErrors.update(items=>{const next={...items};delete next[camera.id];return next});this.http.get<{mode:"hls"|"player"|"webrtc";endpoint?:string}>(`/api/cameras/${camera.id}/stream`).subscribe({next:value=>{const endpoint=value.endpoint;if(value.mode==="player"&&endpoint)this.players.update(items=>({...items,[camera.id]:{mode:"player",safeEndpoint:this.sanitizer.bypassSecurityTrustResourceUrl(endpoint)}}));else if(value.mode==="webrtc")this.players.update(items=>({...items,[camera.id]:{mode:"webrtc"}}));else if(value.mode==="hls"&&endpoint)this.players.update(items=>({...items,[camera.id]:{mode:"hls",endpoint}}));else this.fail(camera,"The stream is currently unavailable.")},error:()=>this.fail(camera,"Check the camera connection and try again.")})}
  fallback(camera:Camera){this.http.get<{endpoint?:string}>(`/api/cameras/${camera.id}/stream?transport=hls`).subscribe({next:value=>{if(value.endpoint)this.players.update(items=>({...items,[camera.id]:{mode:"hls",endpoint:value.endpoint}}));else this.fail(camera,"This video format is unavailable.")},error:()=>this.fail(camera,"Unable to switch video format.")})}
  private fail(camera:Camera,message:string){this.streamErrors.update(items=>({...items,[camera.id]:message}))}
  ngOnDestroy(){if(this.timer)window.clearTimeout(this.timer);try{const payload=JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1]));if(payload.role==="CAMERA_GUEST")sessionStorage.removeItem("access_token")}catch{}}
}
