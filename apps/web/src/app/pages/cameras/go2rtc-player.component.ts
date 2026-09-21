import { AfterViewInit, Component, ElementRef, Input, OnDestroy, ViewChild, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { SafeResourceUrl } from "@angular/platform-browser";

/**
 * Keeps go2rtc's transport player isolated in an iframe, but replaces its
 * browser-native controls with the three actions people actually need.
 * The iframe is served through our same-origin nginx proxy, so its video can
 * safely be controlled here without exposing the go2rtc API to the browser.
 */
@Component({
  selector: "app-go2rtc-player",
  standalone: true,
  template: `
    <iframe #frame [src]="src" [title]="title" scrolling="no" allow="autoplay; fullscreen; picture-in-picture" (load)="attach()"></iframe>
    <div class="actions" aria-label="Video controls">
      @if(cameraId){<button type="button" title="Управление камерой" [class.active]="ptzOpen" (click)="togglePtz($event)">⌖</button>}
      <button type="button" title="Sound" (click)="toggleMuted($event)">{{muted ? '🔇' : '🔊'}}</button>
      <button type="button" title="Picture in picture" (click)="pictureInPicture($event)">▣</button>
      <button type="button" title="Full screen" (click)="fullScreen($event)">⛶</button>
    </div>
    @if(ptzOpen&&cameraId){
      <div class="ptz" aria-label="Управление камерой">
        <button type="button" aria-label="Вверх" (pointerdown)="startPtz($event,'UP')" (pointerup)="stopPtz()" (pointercancel)="stopPtz()" (pointerleave)="stopPtz()">↑</button>
        <button type="button" aria-label="Влево" (pointerdown)="startPtz($event,'LEFT')" (pointerup)="stopPtz()" (pointercancel)="stopPtz()" (pointerleave)="stopPtz()">←</button>
        <button type="button" aria-label="Остановить" class="stop" (click)="stopPtz(true)">■</button>
        <button type="button" aria-label="Вправо" (pointerdown)="startPtz($event,'RIGHT')" (pointerup)="stopPtz()" (pointercancel)="stopPtz()" (pointerleave)="stopPtz()">→</button>
        <button type="button" aria-label="Вниз" (pointerdown)="startPtz($event,'DOWN')" (pointerup)="stopPtz()" (pointercancel)="stopPtz()" (pointerleave)="stopPtz()">↓</button>
        @if(ptzError){<small>{{ptzError}}</small>}
      </div>
    }
  `,
  styles: [`
    :host{position:relative;display:block;width:100%;height:100%;overflow:hidden;background:#020305}
    iframe{display:block;width:100%;height:100%;border:0}
    .actions{position:absolute;right:10px;bottom:10px;z-index:5;display:flex;gap:6px;padding:5px;border:1px solid #ffffff24;border-radius:10px;background:#080b12b8;backdrop-filter:blur(8px);opacity:0;transition:opacity .16s}
    :host:hover .actions,:host:focus-within .actions{opacity:1}
    button{display:grid;place-items:center;width:31px;height:31px;padding:0;border:0;border-radius:7px;background:#ffffff12;color:#f6f7fb;font:600 17px/1 system-ui;cursor:pointer}
    button:hover{background:#ffffff2a}
    button.active{background:#5868ef}.ptz{position:absolute;right:10px;bottom:52px;z-index:5;display:grid;grid-template-columns:repeat(3,31px);gap:5px;padding:6px;border:1px solid #ffffff24;border-radius:10px;background:#080b12dc;backdrop-filter:blur(8px)}.ptz button:nth-child(1){grid-column:2}.ptz button:nth-child(2){grid-column:1}.ptz .stop{grid-column:2;background:#ffffff20;font-size:11px}.ptz button:nth-child(4){grid-column:3}.ptz button:nth-child(5){grid-column:2}.ptz small{grid-column:1/-1;max-width:120px;color:#ffbac4;font:600 9px/1.3 system-ui;text-align:center}
    @media (hover:none){.actions{opacity:1}}
  `]
})
export class Go2rtcPlayerComponent implements AfterViewInit, OnDestroy {
  private http = inject(HttpClient);
  @Input({ required: true }) src!: SafeResourceUrl;
  @Input() cameraId?: string;
  @Input() title = "Camera stream";
  @ViewChild("frame", { static: true }) frame!: ElementRef<HTMLIFrameElement>;
  muted = true;
  ptzOpen = false;
  ptzError = "";
  private ptzMoving = false;
  private timer?: ReturnType<typeof setInterval>;
  private guardedVideo?: HTMLVideoElement;
  private pausedListener = () => { void this.guardedVideo?.play().catch(() => {}); };

  ngAfterViewInit(){ this.attach(); }
  ngOnDestroy(){ if(this.timer) clearInterval(this.timer); this.guardedVideo?.removeEventListener("pause", this.pausedListener); }

  attach(){
    if(this.timer) clearInterval(this.timer);
    // go2rtc creates its <video> asynchronously. Retry briefly after iframe load.
    let attempts = 0;
    this.timer = setInterval(() => {
      attempts++;
      const video = this.video();
      if(video){
        video.controls = false;
        video.disablePictureInPicture = false;
        video.muted = this.muted;
        if(this.guardedVideo !== video){
          this.guardedVideo?.removeEventListener("pause", this.pausedListener);
          this.guardedVideo = video;
          video.addEventListener("pause", this.pausedListener);
        }
        if(this.timer) clearInterval(this.timer);
      } else if(attempts >= 40 && this.timer) clearInterval(this.timer);
    }, 250);
  }

  toggleMuted(event: Event){ event.stopPropagation(); const video=this.video(); if(!video)return; video.muted=!video.muted; this.muted=video.muted; }
  async pictureInPicture(event: Event){ event.stopPropagation(); const video=this.video(); if(!video||!document.pictureInPictureEnabled)return; try{ if(document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); }catch{} }
  async fullScreen(event: Event){ event.stopPropagation(); const video=this.video(); if(!video)return; try{ await video.requestFullscreen(); }catch{} }
  togglePtz(event:Event){event.stopPropagation();this.ptzOpen=!this.ptzOpen;this.ptzError="";}
  startPtz(event:PointerEvent,direction:"UP"|"DOWN"|"LEFT"|"RIGHT"){event.preventDefault();event.stopPropagation();if(!this.cameraId)return;this.ptzMoving=true;this.sendPtz(direction);}
  stopPtz(force=false){if(!this.ptzMoving&&!force)return;this.ptzMoving=false;this.sendPtz("STOP");}
  private sendPtz(direction:"UP"|"DOWN"|"LEFT"|"RIGHT"|"STOP"){if(!this.cameraId)return;this.ptzError="";this.http.post(`/api/cameras/${this.cameraId}/control`,{action:"ptz",direction}).subscribe({error:({error})=>this.ptzError=error?.message||"Команда не выполнена"});}
  private video(): HTMLVideoElement|undefined { try { return this.frame?.nativeElement.contentDocument?.querySelector("video") || undefined; } catch { return undefined; } }
}
