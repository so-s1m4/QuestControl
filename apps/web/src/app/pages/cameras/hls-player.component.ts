import { AfterViewInit, Component, ElementRef, Input, OnDestroy, signal, ViewChild } from "@angular/core";
import Hls from "hls.js";

@Component({
  selector: "app-hls-player",
  standalone: true,
  template: `
    <video #video controls autoplay muted playsinline></video>
    @if(error()){<p class="stream-error">{{error()}}</p>}
  `,
  styles: [`.stream-error{position:absolute;inset:auto 16px 16px;margin:0;padding:10px 12px;border-radius:7px;background:#8f1d2c;color:white}`]
})
export class HlsPlayerComponent implements AfterViewInit, OnDestroy {
  @Input({ required: true }) url!: string;
  @ViewChild("video", { static: true }) video!: ElementRef<HTMLVideoElement>;
  private hls?: Hls;
  error = signal("");

  ngAfterViewInit() {
    const element = this.video.nativeElement;
    element.muted = true;
    if (Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        liveSyncDurationCount: 1,
        liveMaxLatencyDurationCount: 2,
        maxLiveSyncPlaybackRate: 1.5,
        backBufferLength: 0,
        maxBufferLength: 4,
      });
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        element.play().catch(() => this.error.set("Нажмите Play, чтобы запустить видео."));
      });
      this.hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) this.error.set(`Ошибка потока: ${data.details}`);
      });
      this.hls.loadSource(this.url);
      this.hls.attachMedia(element);
    } else if (element.canPlayType("application/vnd.apple.mpegurl")) {
      element.src = this.url;
      element.play().catch(() => this.error.set("Нажмите Play, чтобы запустить видео."));
    } else {
      this.error.set("Этот браузер не поддерживает HLS.");
    }
  }

  ngOnDestroy() {
    this.hls?.destroy();
  }
}
