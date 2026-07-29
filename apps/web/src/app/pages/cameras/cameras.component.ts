import { Component, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { DomSanitizer, SafeResourceUrl } from "@angular/platform-browser";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { HlsPlayerComponent } from "./hls-player.component";

type Camera = {
  id: string;
  room_id: string | null;
  room_name: string | null;
  name: string;
  provider: "RTSP" | "ONVIF" | "TUYA";
  stream_key: string | null;
  external_id: string | null;
  status: string;
};

type Room = { id: string; name: string; location_name:string };

@Component({
  selector: "app-cameras",
  standalone: true,
  imports: [FormsModule, RouterLink, HlsPlayerComponent],
  template: `
    <main>
      <aside>
        <h1>Q <span>QUESTCONTROL</span></h1>
        <nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a class="active" routerLink="/cameras">Камеры</a><a routerLink="/krampus">Krampus House</a><a routerLink="/users">Пользователи</a></nav>
      </aside>
      <section>
        <header>
          <div><h2>Камеры</h2><p>Выберите камеры и следите за ними в общей сетке</p></div>
          <div class="header-actions">
            <button class="secondary" (click)="syncTuya()" [disabled]="syncing()">{{syncing() ? "Синхронизация…" : "↻ Синхронизировать Tuya"}}</button>
            <button (click)="showForm.set(!showForm())">{{showForm() ? "Закрыть" : "+ Добавить камеру"}}</button>
          </div>
        </header>

        @if (showForm()) {
          <form (ngSubmit)="save()">
            <label>Название<input name="name" [(ngModel)]="draft.name" required minlength="2" placeholder="Камера в комнате 1"></label>
            <label>Комната<select name="roomId" [(ngModel)]="draft.roomId" required><option value="">Выберите комнату</option>@for(room of rooms();track room.id){<option [value]="room.id">{{room.location_name}} · {{room.name}}</option>}</select></label>
            <label>Источник<select name="provider" [(ngModel)]="draft.provider"><option value="RTSP">RTSP через go2rtc</option><option value="ONVIF">ONVIF через go2rtc</option><option value="TUYA">Tuya Cloud</option></select></label>
            @if (draft.provider === "TUYA") {
              <label>Tuya device ID<input name="externalId" [(ngModel)]="draft.externalId" required></label>
              <p class="hint">Tuya live stream пока не активирован на сервере.</p>
            } @else {
              <label>Stream key<input name="streamKey" [(ngModel)]="draft.streamKey" required pattern="[A-Za-z0-9_-]+" placeholder="room_1_main"></label>
              <p class="hint">Это имя потока из go2rtc.yaml, не RTSP URL и не пароль.</p>
            }
            <button type="submit" [disabled]="saving()">{{saving() ? "Сохраняем…" : "Сохранить"}}</button>
          </form>
        }

        @if (error()) { <p class="error">{{error()}}</p> }
        @if (notice()) { <p class="notice">{{notice()}}</p> }
        @if (loading()) { <p>Загрузка камер…</p> }
        @else if (!cameras().length) { <div class="empty"><b>Камер пока нет</b><span>Добавьте поток, уже настроенный в go2rtc.</span></div> }
        @else {
          <div class="camera-picker">
            <div>
              <strong>Отслеживаемые камеры</strong>
              <span>Выбрано {{selectedCameras().length}} из {{cameras().length}}</span>
            </div>
            <div class="camera-options">
              @for(camera of cameras();track camera.id) {
                <label class="camera-option">
                  <input type="checkbox" [checked]="isSelected(camera.id)" (change)="toggle(camera)">
                  <span><b>{{camera.name}}</b><small>{{camera.room_name || "Без комнаты"}} · {{camera.provider}}</small></span>
                </label>
              }
            </div>
          </div>

          @if (!selectedCameras().length) {
            <div class="empty"><b>Ничего не выбрано</b><span>Отметьте камеры выше, чтобы начать наблюдение.</span></div>
          }
          <div class="camera-grid">
            @for(camera of selectedCameras();track camera.id) {
              <article>
                <div class="preview">
                  @if (players()[camera.id]; as player) {
                    @if (player.mode === "hls") { <app-hls-player [url]="player.endpoint"></app-hls-player> }
                    @else { <iframe [src]="player.safeEndpoint!" [title]="camera.name" allow="autoplay; fullscreen" referrerpolicy="same-origin"></iframe> }
                  }
                  @else { <button class="play" (click)="open(camera)">▶ Открыть поток</button> }
                </div>
                <div class="camera-info">
                  <div class="camera-meta"><strong>{{camera.name}}</strong><span>{{camera.room_name || "Комната не назначена"}} · {{camera.provider}}</span><select [value]="camera.room_id||''" (change)="assignRoom(camera,$event)"><option value="">Назначить комнату…</option>@for(room of rooms();track room.id){<option [value]="room.id">{{room.location_name}} · {{room.name}}</option>}</select></div>
                  <div class="camera-actions"><button class="secondary" (click)="refresh(camera)">Обновить</button><button class="danger" title="Удалить" (click)="remove(camera)">Удалить</button></div>
                </div>
              </article>
            }
          </div>
        }
      </section>
    </main>
  `,
  styles: [`
    .camera-picker{display:flex;justify-content:space-between;gap:24px;align-items:flex-start;margin-top:24px;padding:18px;background:white;border:1px solid #e1e5ed;border-radius:11px}
    .camera-picker>div:first-child{min-width:190px}.camera-picker strong,.camera-picker span{display:block}.camera-picker>div:first-child span{margin-top:6px;color:#788295;font-size:12px}
    .camera-options{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:10px}
    .camera-option{display:flex;grid-template-columns:none;align-items:center;gap:10px;min-width:190px;padding:10px 12px;border:1px solid #dfe3eb;border-radius:8px;cursor:pointer}
    .camera-option:has(input:checked){border-color:#4058df;background:#f1f3ff}.camera-option input{width:16px;height:16px;accent-color:#4058df}
    .camera-option b,.camera-option small{display:block}.camera-option small{margin-top:3px;color:#788295;font-size:11px}
    .camera-grid{grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))}
    .camera-meta select{margin-top:9px;min-width:240px;padding:7px 9px}.camera-actions{display:flex;gap:8px}.secondary{padding:8px 10px;background:#eef1f6;color:#344054}
    .header-actions{display:flex;gap:10px}.notice{padding:12px 14px;border-radius:8px;background:#ecfdf3;color:#067647}
    @media(max-width:900px){.camera-picker{display:grid}.camera-options{justify-content:stretch}.camera-option{width:100%}}
  `]
})
export class CamerasComponent {
  private http = inject(HttpClient);
  private sanitizer = inject(DomSanitizer);
  cameras = signal<Camera[]>([]);
  rooms = signal<Room[]>([]);
  players = signal<Record<string, { mode: "hls" | "player"; endpoint: string; safeEndpoint?: SafeResourceUrl }>>({});
  loading = signal(true);
  saving = signal(false);
  syncing = signal(false);
  showForm = signal(false);
  error = signal("");
  notice = signal("");
  selectedIds = signal<string[]>([]);
  draft = { name: "", roomId: "", provider: "RTSP" as Camera["provider"], streamKey: "", externalId: "" };

  constructor() {
    this.load();
    this.http.get<Room[]>("/api/rooms").subscribe({ next: rooms => this.rooms.set(rooms) });
  }

  load() {
    this.loading.set(true);
    this.http.get<Camera[]>("/api/cameras").subscribe({
      next: cameras => {
        this.cameras.set(cameras);
        const stored = localStorage.getItem("questcontrol.selectedCameras");
        const requested = stored === null ? cameras.map(camera => camera.id) : this.parseSelection(stored);
        const available = new Set(cameras.map(camera => camera.id));
        const selected = requested.filter(id => available.has(id));
        this.selectedIds.set(selected);
        this.persistSelection();
        for (const camera of cameras) if (selected.includes(camera.id)) this.open(camera);
        this.loading.set(false);
      },
      error: () => { this.error.set("Не удалось загрузить камеры."); this.loading.set(false); }
    });
  }

  save() {
    this.saving.set(true);
    this.error.set("");
    const body = {
      name: this.draft.name,
      roomId: this.draft.roomId || null,
      provider: this.draft.provider,
      streamKey: this.draft.provider === "TUYA" ? null : this.draft.streamKey,
      externalId: this.draft.provider === "TUYA" ? this.draft.externalId : null
    };
    this.http.post<Camera>("/api/cameras", body).subscribe({
      next: () => {
        this.draft = { name: "", roomId: "", provider: "RTSP", streamKey: "", externalId: "" };
        this.saving.set(false);
        this.showForm.set(false);
        this.load();
      },
      error: ({ status }) => { this.error.set(status === 403 ? "Нет права управлять камерами." : "Не удалось сохранить камеру. Проверьте поля."); this.saving.set(false); }
    });
  }

  syncTuya() {
    this.syncing.set(true);
    this.error.set("");
    this.notice.set("");
    this.http.post<{discovered:number;cameras:number;created:number;updated:number}>("/api/cameras/sync/tuya", {}).subscribe({
      next: result => {
        this.syncing.set(false);
        this.notice.set(`Tuya: найдено устройств ${result.discovered}, камер ${result.cameras}, добавлено ${result.created}, обновлено ${result.updated}.`);
        this.load();
      },
      error: ({ error }) => {
        this.syncing.set(false);
        this.error.set(error?.message ? `Tuya: ${error.message}` : "Не удалось синхронизировать устройства Tuya.");
      }
    });
  }

  open(camera: Camera) {
    this.error.set("");
    this.http.get<{ endpoint: string; mode: "hls" | "player" }>(`/api/cameras/${camera.id}/stream`).subscribe({
      next: ({ endpoint, mode }) => this.players.update(value => ({
        ...value,
        [camera.id]: { mode, endpoint, safeEndpoint: mode === "player" ? this.sanitizer.bypassSecurityTrustResourceUrl(endpoint) : undefined }
      })),
      error: ({ status }) => this.error.set(status === 503 ? "Укажите Tuya Client ID и Client Secret на сервере." : "Поток LSC/Tuya недоступен. Проверьте привязку устройства и услугу Live Stream.")
    });
  }

  selectedCameras() {
    const selected = new Set(this.selectedIds());
    return this.cameras().filter(camera => selected.has(camera.id));
  }

  isSelected(id: string) {
    return this.selectedIds().includes(id);
  }

  toggle(camera: Camera) {
    if (this.isSelected(camera.id)) {
      this.selectedIds.update(ids => ids.filter(id => id !== camera.id));
      this.players.update(players => {
        const next = { ...players };
        delete next[camera.id];
        return next;
      });
    } else {
      this.selectedIds.update(ids => [...ids, camera.id]);
      this.open(camera);
    }
    this.persistSelection();
  }

  refresh(camera: Camera) {
    this.players.update(players => {
      const next = { ...players };
      delete next[camera.id];
      return next;
    });
    this.open(camera);
  }

  assignRoom(camera:Camera,event:Event){
    const roomId=(event.target as HTMLSelectElement).value;
    if(!roomId)return;
    this.error.set("");
    this.http.patch(`/api/cameras/${camera.id}/room`,{roomId}).subscribe({next:()=>{this.notice.set("Камера назначена комнате.");this.load();},error:()=>this.error.set("Не удалось назначить камеру комнате.")});
  }

  private parseSelection(value: string) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  private persistSelection() {
    localStorage.setItem("questcontrol.selectedCameras", JSON.stringify(this.selectedIds()));
  }

  remove(camera: Camera) {
    if (!confirm(`Удалить камеру «${camera.name}»?`)) return;
    this.http.delete(`/api/cameras/${camera.id}`).subscribe({
      next: () => {
        this.selectedIds.update(ids => ids.filter(id => id !== camera.id));
        this.persistSelection();
        this.load();
      },
      error: ({ status }) => this.error.set(status === 403 ? "Нет права удалять камеры." : "Не удалось удалить камеру.")
    });
  }
}
