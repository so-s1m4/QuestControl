import { Component, HostListener, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { DomSanitizer, SafeResourceUrl } from "@angular/platform-browser";
import { HlsPlayerComponent } from "../pages/cameras/hls-player.component";

type Camera={id:string;name:string;room_name:string|null};
type Player={mode:"hls"|"player";endpoint:string;safeEndpoint?:SafeResourceUrl};

@Component({
  selector:"app-camera-overlay",standalone:true,imports:[HlsPlayerComponent],
  template:`
    @if(selected().length){
      <section class="watch" [class.collapsed]="collapsed()">
        <header><div><b>Камеры</b><span>{{selected().length}} выбрано</span></div><div><button (click)="collapsed.set(!collapsed())">{{collapsed()?"Развернуть":"Свернуть"}}</button><button class="close" (click)="clear()">×</button></div></header>
        @if(!collapsed()){<div class="grid">@for(camera of selected();track camera.id){<article><div class="video">@if(players()[camera.id];as player){@if(player.mode==="hls"){<app-hls-player [url]="player.endpoint"/>}@else{<iframe [src]="player.safeEndpoint!" [title]="camera.name" allow="autoplay; fullscreen"></iframe>}}@else{<button (click)="open(camera)">▶ Открыть</button>}</div><footer><span><b>{{camera.name}}</b><small>{{camera.room_name||"Без комнаты"}}</small></span><button (click)="remove(camera.id)">×</button></footer></article>}</div>}
      </section>
    }`,
  styles:[`
    .watch{position:fixed;z-index:900;right:20px;bottom:20px;width:min(760px,calc(100vw - 40px));max-width:calc(100vw - 40px);max-height:calc(100vh - 40px);overflow:auto;border:1px solid #d5dae5;border-radius:16px;background:#fff;box-shadow:0 20px 60px #10182845}.watch>header{position:sticky;z-index:2;top:0;display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:#111a2b;color:#fff}.watch>header div{display:flex;align-items:center;gap:9px}.watch>header span{font-size:11px;color:#aeb7c8}.watch button{padding:7px 9px;background:#29344a;color:#fff;box-shadow:none}.watch .close{font-size:18px;line-height:1}.watch.collapsed{width:260px}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));width:100%;min-width:0;overflow:hidden;gap:1px;background:#d8dce5}.grid article{width:100%;min-width:0;max-width:100%;overflow:hidden;background:#fff}.video{display:grid;place-items:center;width:100%;min-width:0;max-width:100%;overflow:hidden;aspect-ratio:16/9;background:#101622}.video iframe,.video app-hls-player{display:block;width:100%;min-width:0;max-width:100%;height:100%;border:0}.video>button{background:#29344a}.grid footer{display:flex;justify-content:space-between;align-items:center;min-width:0;padding:9px 11px}.grid footer span b,.grid footer span small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.grid footer span{min-width:0}.grid footer small{margin-top:2px;color:#7b8495;font-size:9px}.grid footer button{background:#eef1f6;color:#344054}
    @media(max-width:650px){.watch{right:10px;bottom:10px;width:calc(100vw - 20px)}.grid{grid-template-columns:1fr}}
  `]
})
export class CameraOverlayComponent{
  private http=inject(HttpClient);private sanitizer=inject(DomSanitizer);
  cameras=signal<Camera[]>([]);selectedIds=signal<string[]>([]);players=signal<Record<string,Player>>({});collapsed=signal(false);
  constructor(){this.reload()}
  @HostListener("window:questcontrol-camera-selection") selectionChanged(){this.readSelection()}
  reload(){if(!sessionStorage.getItem("access_token"))return;this.http.get<Camera[]>("/api/cameras").subscribe({next:c=>{this.cameras.set(c);this.readSelection()}})}
  readSelection(){try{const ids=JSON.parse(localStorage.getItem("questcontrol.selectedCameras")||"[]");this.selectedIds.set(Array.isArray(ids)?ids:[]);for(const camera of this.selected())if(!this.players()[camera.id])this.open(camera)}catch{this.selectedIds.set([])}}
  selected(){const ids=new Set(this.selectedIds());return this.cameras().filter(c=>ids.has(c.id))}
  open(camera:Camera){this.http.get<{endpoint:string;mode:"hls"|"player"}>(`/api/cameras/${camera.id}/stream`).subscribe({next:p=>this.players.update(v=>({...v,[camera.id]:{...p,safeEndpoint:p.mode==="player"?this.sanitizer.bypassSecurityTrustResourceUrl(p.endpoint):undefined}}))})}
  remove(id:string){this.selectedIds.update(ids=>ids.filter(value=>value!==id));this.persist();this.players.update(v=>{const next={...v};delete next[id];return next})}
  clear(){this.selectedIds.set([]);this.players.set({});this.persist()}
  persist(){localStorage.setItem("questcontrol.selectedCameras",JSON.stringify(this.selectedIds()));window.dispatchEvent(new Event("questcontrol-camera-selection"))}
}
