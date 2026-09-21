import { AfterViewInit, Component, ElementRef, Input, OnDestroy, ViewChild } from "@angular/core";
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
      <button type="button" title="Sound" (click)="toggleMuted($event)">{{muted ? '🔇' : '🔊'}}</button>
      <button type="button" title="Picture in picture" (click)="pictureInPicture($event)">▣</button>
      <button type="button" title="Full screen" (click)="fullScreen($event)">⛶</button>
    </div>
  `,
  styles: [`
    :host{position:relative;display:block;width:100%;height:100%;overflow:hidden;background:#020305}
    iframe{display:block;width:100%;height:100%;border:0}
    .actions{position:absolute;right:10px;bottom:10px;z-index:5;display:flex;gap:6px;padding:5px;border:1px solid #ffffff24;border-radius:10px;background:#080b12b8;backdrop-filter:blur(8px);opacity:0;transition:opacity .16s}
    :host:hover .actions,:host:focus-within .actions{opacity:1}
    button{display:grid;place-items:center;width:31px;height:31px;padding:0;border:0;border-radius:7px;background:#ffffff12;color:#f6f7fb;font:600 17px/1 system-ui;cursor:pointer}
    button:hover{background:#ffffff2a}
    @media (hover:none){.actions{opacity:1}}
  `]
})
export class Go2rtcPlayerComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) src!: SafeResourceUrl;
  @Input() title = "Camera stream";
  @ViewChild("frame", { static: true }) frame!: ElementRef<HTMLIFrameElement>;
  muted = true;
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
  private video(): HTMLVideoElement|undefined { try { return this.frame?.nativeElement.contentDocument?.querySelector("video") || undefined; } catch { return undefined; } }
}
