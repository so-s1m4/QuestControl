import { Component, OnDestroy, inject, signal } from "@angular/core";
import { ActivatedRoute } from "@angular/router";
import { HttpClient } from "@angular/common/http";
import { WebRtcPlayerComponent } from "../cameras/webrtc-player.component";
import { HlsPlayerComponent } from "../cameras/hls-player.component";

type Camera={id:string;name:string;room_name:string|null;status:string;provider:string};
@Component({selector:"app-camera-watch",standalone:true,imports:[WebRtcPlayerComponent,HlsPlayerComponent],template:`
<main class="watch-page"><header><b>Q</b><div><h1>Камеры комнаты</h1><p>Закрытая трансляция для родителей</p></div></header>
@if(error()){<section class="empty"><h2>Доступ недоступен</h2><p>{{error()}}</p></section>}
@else if(loading()){<section class="empty"><p>Подключаем камеры…</p></section>}
@else{<section class="grid" [class.single]="cameras().length===1">@for(camera of cameras();track camera.id){<article><div class="video">@if(hls()[camera.id];as url){<app-hls-player [url]="url"/>}@else if(camera.provider==='TUYA'){<app-webrtc-player [cameraId]="camera.id" (fallbackRequested)="fallback(camera)"/>}@else{<button (click)="fallback(camera)">▶ Открыть</button>}</div><footer><i [class.online]="camera.status==='ONLINE'"></i><span><b>{{camera.name}}</b><small>{{camera.room_name||'Комната'}}</small></span></footer></article>}@empty{<div class="empty"><p>Для этой ссылки камеры не выбраны.</p></div>}</section>}</main>`,styles:[`
:host{display:block;min-height:100vh;background:#070a10}.watch-page{display:block;min-height:100vh;padding:20px;background:#070a10;color:#eef2f7}header{display:flex;align-items:center;gap:12px;margin-bottom:18px}header>b{display:grid;width:40px;height:40px;place-items:center;border-radius:10px;background:#5865e8;font-size:23px}h1{margin:0;font-size:19px}header p{margin:3px 0 0;color:#8995a6;font-size:10px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(480px,100%),1fr));gap:12px}.grid.single{max-width:1100px;margin:auto}article{overflow:hidden;border:1px solid #293347;border-radius:10px;background:#101722}.video{display:grid;aspect-ratio:16/9;overflow:hidden;place-items:center;background:#020305}.video app-webrtc-player,.video app-hls-player{display:block;width:100%;height:100%}.video button{background:#253149;color:white}footer{display:flex;align-items:center;gap:9px;padding:10px 12px}footer i{width:8px;height:8px;border-radius:50%;background:#667085}footer i.online{background:#12b76a;box-shadow:0 0 8px #12b76a}footer b,footer small{display:block}footer small{margin-top:2px;color:#7f8b9d;font-size:9px}.empty{display:grid;min-height:60vh;place-content:center;text-align:center}.empty h2{margin:0}.empty p{color:#98a2b3}@media(max-width:600px){.watch-page{padding:12px}.grid{grid-template-columns:1fr;gap:9px}}
`]})
export class CameraWatchComponent implements OnDestroy{
 private http=inject(HttpClient);private route=inject(ActivatedRoute);private timer?:number;
 cameras=signal<Camera[]>([]);hls=signal<Record<string,string>>({});loading=signal(true);error=signal("");
 constructor(){this.connect()}
 connect(){const token=this.route.snapshot.paramMap.get("token");if(!token)return;this.http.post<{accessToken:string}>(`/api/camera-shares/${encodeURIComponent(token)}/access`,{}).subscribe({next:value=>{sessionStorage.setItem("access_token",value.accessToken);this.load();this.timer=window.setTimeout(()=>this.connect(),10*60_000)},error:()=>{this.loading.set(false);this.error.set("Ссылка истекла или была отозвана администратором.")}})}
 load(){this.http.get<Camera[]>("/api/cameras").subscribe({next:value=>{this.cameras.set(value);this.loading.set(false)},error:()=>{this.loading.set(false);this.error.set("Не удалось подключиться к трансляции.")}})}
 fallback(camera:Camera){this.http.get<{endpoint?:string}>(`/api/cameras/${camera.id}/stream?transport=hls`).subscribe({next:value=>{if(value.endpoint)this.hls.update(items=>({...items,[camera.id]:value.endpoint!}))}})}
 ngOnDestroy(){if(this.timer)window.clearTimeout(this.timer);try{const payload=JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1]));if(payload.role==="CAMERA_GUEST")sessionStorage.removeItem("access_token")}catch{}}
}
