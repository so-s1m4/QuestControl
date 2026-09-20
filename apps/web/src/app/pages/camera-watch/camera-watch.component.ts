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
    <div class="headline"><span class="eyebrow">QUEST CONTROL · ГОСТЕВОЙ ДОСТУП</span><h1>Камеры локации</h1><p>Только просмотр · ссылка защищена и временно действует</p></div>
    <div class="secure"><span>●</span><div><b>Защищённый просмотр</b><small>Доступ только к выбранным камерам</small></div></div>
  </header>
  @if(error()){<section class="state error"><span>!</span><h2>Доступ недоступен</h2><p>{{error()}}</p></section>}
  @else if(loading()){<section class="state"><span class="spinner"></span><h2>Подключаем камеры</h2><p>Проверяем защищённый доступ к трансляциям…</p></section>}
  @else{
    <section class="watch-summary"><div><b>{{cameras().length}}</b><span>{{cameras().length===1?'камера доступна':'камер доступно'}}</span></div><p>Чтобы открыть на весь экран, нажмите ⛶ в нужной трансляции.</p><button type="button" (click)="reloadPlayers()">↻ Обновить видео</button></section>
    <section class="grid" [class.single]="cameras().length===1">
      @for(camera of cameras();track camera.id){
        <article>
          <div class="video">
            @if(players()[camera.id];as player){
              @if(player.mode==='player'){<iframe [src]="player.safeEndpoint!" [title]="camera.name" allow="autoplay; fullscreen; picture-in-picture"></iframe>}
              @else if(player.mode==='webrtc'){<app-webrtc-player [cameraId]="camera.id" [allowHlsFallback]="true" (fallbackRequested)="fallback(camera)"/>}
              @else if(player.endpoint){<app-hls-player [url]="player.endpoint"/>}
            }@else if(streamErrors()[camera.id];as streamError){
              <div class="video-error"><span>!</span><b>Не удалось открыть видео</b><small>{{streamError}}</small><button type="button" (click)="open(camera)">Повторить</button></div>
            }@else{
              <div class="video-loading"><span class="spinner"></span><p>Подключение…</p></div>
            }
          </div>
          <footer><i [class.online]="camera.status==='ONLINE'"></i><div><b>{{camera.name}}</b><small>{{camera.room_name||'Камера локации'}}</small></div><span>{{camera.status==='ONLINE'?'Онлайн':'Нет связи'}}</span></footer>
        </article>
      }@empty{<section class="state empty-list"><h2>Камеры не выбраны</h2><p>Попросите администратора создать новую ссылку.</p></section>}
    </section>
  }
</main>
`,styles:[`
:host{display:block;min-height:100vh;background:#090d16}.watch-page{min-height:100vh;padding:clamp(14px,3vw,40px);color:#edf2ff;background:radial-gradient(circle at 85% -10%,#5865e842,transparent 30%),radial-gradient(circle at 4% 100%,#11b98118,transparent 34%),#090d16;font-family:Inter,system-ui,sans-serif}.watch-header{display:flex;align-items:center;gap:15px;max-width:1500px;margin:0 auto 22px;padding:16px 18px;border:1px solid #ffffff16;border-radius:18px;background:#111827bb;box-shadow:0 16px 38px #0004;backdrop-filter:blur(14px)}.brand-mark{display:grid;flex:none;width:45px;height:45px;place-items:center;border-radius:13px;background:linear-gradient(135deg,#7883ff,#4855d8);box-shadow:0 8px 20px #5360df55;font-size:25px;font-weight:900}.headline{min-width:0}.eyebrow{color:#9ba8ff;font-size:9px;font-weight:800;letter-spacing:.13em}.headline h1{margin:3px 0 0;font-size:clamp(19px,2.4vw,27px);letter-spacing:-.04em}.headline p{margin:4px 0 0;color:#9eabc0;font-size:11px}.secure{display:flex;align-items:center;gap:9px;margin-left:auto;padding:8px 11px;border:1px solid #2b7b63;border-radius:12px;background:#0b2b27a8;color:#b5f5dc}.secure>span{color:#36d28f;font-size:21px;line-height:1}.secure b,.secure small{display:block}.secure b{font-size:10px}.secure small{margin-top:2px;color:#78c9a8;font-size:9px}.watch-summary{display:flex;align-items:center;gap:13px;max-width:1500px;margin:0 auto 14px;padding:10px 13px;border:1px solid #ffffff12;border-radius:13px;background:#101724aa;color:#aeb9cb;font-size:11px}.watch-summary>div{display:flex;align-items:baseline;gap:6px;color:#eef2ff}.watch-summary b{font-size:21px}.watch-summary p{flex:1;margin:0}.watch-summary button,.video-error button{border:1px solid #6472f4;border-radius:8px;background:#4f5bd9;color:#fff;padding:7px 10px;font:inherit;font-size:10px;font-weight:800;cursor:pointer;box-shadow:0 4px 12px #3f4ac044}.watch-summary button:hover,.video-error button:hover{background:#6572f4}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(440px,100%),1fr));gap:14px;max-width:1500px;margin:auto}.grid.single{max-width:1120px}.grid article{overflow:hidden;border:1px solid #ffffff16;border-radius:16px;background:#111827;box-shadow:0 16px 35px #0004}.video{display:grid;position:relative;overflow:hidden;aspect-ratio:16/9;place-items:center;background:#03060b}.video iframe,.video app-webrtc-player,.video app-hls-player{display:block;width:100%;height:100%;border:0}.video-loading,.video-error{display:grid;place-items:center;gap:8px;padding:20px;text-align:center;color:#aeb9cb}.video-loading p{margin:0;font-size:11px}.spinner{display:block;width:22px;height:22px;border:2px solid #6572f444;border-top-color:#8b95ff;border-radius:50%;animation:spin .8s linear infinite}.video-error>span{display:grid;width:27px;height:27px;place-items:center;border-radius:50%;background:#512435;color:#ffbdc8;font-weight:900}.video-error b{color:#eef2ff;font-size:12px}.video-error small{max-width:320px;color:#8f9bae;font-size:10px}footer{display:flex;align-items:center;gap:9px;padding:11px 13px;background:linear-gradient(90deg,#111827,#131d2d)}footer>i{width:8px;height:8px;flex:none;border-radius:50%;background:#6f7c90}footer>i.online{background:#2ed18c;box-shadow:0 0 10px #2ed18c}footer>div{min-width:0;flex:1}footer b,footer small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}footer b{font-size:12px}footer small{margin-top:3px;color:#8794a9;font-size:10px}footer>span{padding:4px 6px;border-radius:5px;background:#ffffff0d;color:#a9b6c9;font-size:9px;font-weight:800}.state{display:grid;place-items:center;align-content:center;min-height:56vh;max-width:620px;margin:auto;padding:30px;text-align:center;color:#aeb9cb}.state h2{margin:12px 0 4px;color:#f1f5ff;font-size:20px}.state p{margin:0;font-size:12px;line-height:1.5}.state.error>span{display:grid;width:45px;height:45px;place-items:center;border-radius:15px;background:#512435;color:#ffbdc8;font-size:22px;font-weight:900}.empty-list{grid-column:1/-1;min-height:260px}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:640px){.watch-page{padding:10px}.watch-header{align-items:flex-start;padding:13px;gap:10px;border-radius:14px}.brand-mark{width:38px;height:38px;border-radius:11px;font-size:20px}.secure{display:none}.headline p{font-size:10px}.watch-summary{align-items:flex-start;flex-wrap:wrap}.watch-summary p{order:3;flex-basis:100%}.grid{grid-template-columns:1fr;gap:10px}.grid article{border-radius:13px}}
`]})
export class CameraWatchComponent implements OnDestroy{
  private http=inject(HttpClient);private route=inject(ActivatedRoute);private sanitizer=inject(DomSanitizer);private timer?:number;
  cameras=signal<Camera[]>([]);players=signal<Record<string,Player>>({});streamErrors=signal<Record<string,string>>({});loading=signal(true);error=signal("");
  constructor(){this.connect()}
  connect(){const token=this.route.snapshot.paramMap.get("token");if(!token){this.loading.set(false);this.error.set("Некорректная ссылка.");return}this.http.post<{accessToken:string}>(`/api/camera-shares/${encodeURIComponent(token)}/access`,{}).subscribe({next:value=>{sessionStorage.setItem("access_token",value.accessToken);this.load();this.timer=window.setTimeout(()=>this.connect(),10*60_000)},error:()=>{this.loading.set(false);this.error.set("Ссылка истекла или была отозвана администратором.")}})}
  load(){this.http.get<Camera[]>("/api/cameras").subscribe({next:value=>{this.cameras.set(value);this.loading.set(false);this.reloadPlayers()},error:()=>{this.loading.set(false);this.error.set("Не удалось подключиться к трансляции.")}})}
  reloadPlayers(){this.players.set({});this.streamErrors.set({});for(const camera of this.cameras())this.open(camera)}
  open(camera:Camera){this.streamErrors.update(items=>{const next={...items};delete next[camera.id];return next});this.http.get<{mode:"hls"|"player"|"webrtc";endpoint?:string}>(`/api/cameras/${camera.id}/stream`).subscribe({next:value=>{const endpoint=value.endpoint;if(value.mode==="player"&&endpoint)this.players.update(items=>({...items,[camera.id]:{mode:"player",safeEndpoint:this.sanitizer.bypassSecurityTrustResourceUrl(endpoint)}}));else if(value.mode==="webrtc")this.players.update(items=>({...items,[camera.id]:{mode:"webrtc"}}));else if(value.mode==="hls"&&endpoint)this.players.update(items=>({...items,[camera.id]:{mode:"hls",endpoint}}));else this.fail(camera,"Поток пока недоступен.")},error:()=>this.fail(camera,"Проверьте соединение с камерой и попробуйте ещё раз.")})}
  fallback(camera:Camera){this.http.get<{endpoint?:string}>(`/api/cameras/${camera.id}/stream?transport=hls`).subscribe({next:value=>{if(value.endpoint)this.players.update(items=>({...items,[camera.id]:{mode:"hls",endpoint:value.endpoint}}));else this.fail(camera,"Этот формат видео недоступен.")},error:()=>this.fail(camera,"Не удалось переключить формат видео.")})}
  private fail(camera:Camera,message:string){this.streamErrors.update(items=>({...items,[camera.id]:message}))}
  ngOnDestroy(){if(this.timer)window.clearTimeout(this.timer);try{const payload=JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1]));if(payload.role==="CAMERA_GUEST")sessionStorage.removeItem("access_token")}catch{}}
}
