import { Component, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";
type VrSessionLog = {
  id: string;
  game_name: string;
  stations: string[];
  status: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  operator: string;
};
@Component({
  selector: "app-vr-session-logs",
  standalone: true,
  imports: [RouterLink, DatePipe],
  template: ` <main>
    <aside>
      <h1>Q <span>QUESTCONTROL</span></h1>
      <nav>
        <a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a
        ><a class="sessions-nav" routerLink="/sessions">Сессии</a
        ><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a
        ><a routerLink="/cameras">Камеры</a
        ><a routerLink="/inventory">Инвентарь</a
        ><a routerLink="/users">Пользователи</a>
      </nav>
    </aside>
    <section>
      <header>
        <div>
          <a class="back" routerLink="/rooms">← Комнаты</a>
          <h2>Журнал VR-сессий</h2>
          <p>Санкт‑Пёльтен · история запусков ARVI</p>
        </div>
        <button class="secondary" (click)="load()" [disabled]="loading()">
          {{ loading() ? "Обновляем…" : "↻ Обновить" }}
        </button>
      </header>
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
      <div class="log-table">
        <div class="log-head">
          <span>Игра</span><span>Станции</span><span>Оператор</span
          ><span>Начало</span><span>Окончание</span><span>Длительность</span
          ><span>Статус</span>
        </div>
        @for (log of logs(); track log.id) {
          <div class="log-row">
            <span data-label="Игра"
              ><b>{{ log.game_name }}</b></span
            ><span data-label="Станции">{{
              log.stations.length ? log.stations.join(", ") : "—"
            }}</span
            ><span data-label="Оператор">{{ log.operator }}</span
            ><span data-label="Начало">{{
              log.started_at | date: "dd.MM.yyyy HH:mm"
            }}</span
            ><span data-label="Окончание">{{
              log.ended_at ? (log.ended_at | date: "dd.MM.yyyy HH:mm") : "—"
            }}</span
            ><span data-label="Длительность"
              ><b>{{
                log.status === "ACTIVE"
                  ? "Идёт"
                  : formatDuration(log.duration_seconds)
              }}</b></span
            ><span data-label="Статус"
              ><i [class.active]="log.status === 'ACTIVE'">{{
                statusLabel(log.status)
              }}</i></span
            >
          </div>
        } @empty {
          <div class="empty">
            <b>Записей пока нет</b
            ><span
              >Новые запуски и завершения появятся здесь автоматически.</span
            >
          </div>
        }
      </div>
    </section>
  </main>`,
  styles: [
    `
      .back {
        display: inline-block;
        margin-bottom: 9px;
        color: var(--primary);
        text-decoration: none;
        font-weight: 700;
      }
      .secondary {
        background: #eef1f6;
        color: #344054;
        box-shadow: none;
      }
      .log-table {
        margin-top: 26px;
        overflow: hidden;
        border: 1px solid var(--line);
        border-radius: 16px;
        background: #fff;
      }
      .log-head,
      .log-row {
        display: grid;
        grid-template-columns: 1.4fr 1.3fr 1fr 1.15fr 1.15fr 0.8fr 0.8fr;
        gap: 14px;
        align-items: center;
        padding: 14px 18px;
      }
      .log-head {
        background: #f7f8fb;
        color: var(--muted);
        font-size: 11px;
        font-weight: 800;
        text-transform: uppercase;
      }
      .log-row {
        border-top: 1px solid var(--line);
        font-size: 13px;
      }
      .log-row i {
        display: inline-block;
        padding: 6px 8px;
        border-radius: 999px;
        background: #edf7f1;
        color: #087443;
        font-style: normal;
        font-size: 10px;
        font-weight: 800;
      }
      .log-row i.active {
        background: #eef0ff;
        color: #434bc4;
      }
      .empty {
        margin: 0;
        border: 0;
        border-radius: 0;
      }
      @media (max-width: 1000px) {
        .log-head {
          display: none;
        }
        .log-row {
          grid-template-columns: 1fr 1fr;
        }
        .log-row span:before {
          content: attr(data-label);
          display: block;
          margin-bottom: 4px;
          color: var(--muted);
          font-size: 10px;
          font-weight: 800;
          text-transform: uppercase;
        }
      }
      @media (max-width: 600px) {
        .log-row {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class VrSessionLogsComponent {
  private http = inject(HttpClient);
  logs = signal<VrSessionLog[]>([]);
  loading = signal(false);
  error = signal("");
  constructor() {
    this.load();
  }
  load() {
    this.loading.set(true);
    this.http
      .get<VrSessionLog[]>("/api/vr/sankt-poelten/session-logs")
      .subscribe({
        next: (logs) => {
          this.logs.set(logs);
          this.loading.set(false);
          this.error.set("");
        },
        error: () => {
          this.loading.set(false);
          this.error.set("Не удалось загрузить журнал VR-сессий.");
        },
      });
  }
  formatDuration(seconds: number | null) {
    if (seconds === null) return "—";
    const minutes = Math.floor(seconds / 60);
    return minutes < 60
      ? `${minutes} мин`
      : `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`;
  }
  statusLabel(status: string) {
    return status === "ACTIVE"
      ? "Идёт"
      : status === "INTERRUPTED"
        ? "Прервана"
        : "Завершена";
  }
}
