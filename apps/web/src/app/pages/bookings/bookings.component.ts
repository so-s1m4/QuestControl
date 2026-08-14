import { Component, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";
import { catchError, forkJoin, of } from "rxjs";
import QRCode from "qrcode";

type Booking = {
  id: string;
  room_id: string;
  room_name: string;
  customer_name: string;
  customer_phone: string | null;
  starts_at: string;
  ends_at: string;
  players: number;
  amount_cents: number;
  currency: string;
  payment_status: string;
  session_id: string | null;
  session_status: string | null;
};
type CheckedInPlayer = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  age: number | null;
  birthdayDaysAgo: number | null;
  waiverAccepted: boolean;
};
type Game = {
  id: string;
  name: string;
  room_id: string;
  room_name: string;
  location_id: string;
};
type ExternalBooking = {
  id: string;
  localBookingId: string | null;
  sessionId: string | null;
  sessionStatus: string | null;
  gameId: string | null;
  selectedGameName: string | null;
  zoneName: string;
  suggestedGameName: string | null;
  requiresGameSelection: boolean;
  date: string;
  startsAt: string;
  endsAt: string;
  status: string;
  statusDisplay: string;
  customerName: string;
  customerPhone: string | null;
  customerEmail: string | null;
  productName: string;
  players: number;
  amountCents: number;
  currency: string;
  paymentStatus: string;
  paymentStatusDisplay: string;
  checkedIn: number;
  checkInTotal: number;
  checkInPath: string;
  checkedInPlayers: CheckedInPlayer[];
};
type ExternalClub = {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
};

@Component({
  selector: "app-bookings",
  standalone: true,
  imports: [FormsModule, RouterLink, DatePipe],
  template: ` <main>
    <aside>
      <h1>Q <span>QUESTCONTROL</span></h1>
      <nav>
        <a routerLink="/">Обзор</a
        ><a class="active" routerLink="/bookings">Бронирования</a
        ><a class="sessions-nav" routerLink="/sessions">Сессии</a
        ><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a
        ><a routerLink="/cameras">Камеры</a
        ><a routerLink="/users">Пользователи</a>
      </nav>
    </aside>
    <section>
      <header>
        <div>
          <h2>Бронирования</h2>
          <p>Расписание гостей из подключённых систем бронирования</p>
        </div>
        <div class="view-switch">
          <button
            [class.active]="viewMode() === 'calendar'"
            (click)="viewMode.set('calendar')"
          >
            Календарь</button
          ><button
            [class.active]="viewMode() === 'list'"
            (click)="viewMode.set('list')"
          >
            Список
          </button>
        </div>
      </header>
      @if (isManagement()) {
        <div class="archive-import">
          <strong>Импорт истории</strong
          ><label>С<input type="date" [(ngModel)]="archiveFrom" /></label
          ><label>По<input type="date" [(ngModel)]="archiveTo" /></label
          ><button [disabled]="archiveLoading()" (click)="importArchive()">
            {{
              archiveLoading() ? "Импортируем…" : "Импортировать период"
            }}</button
          ><span>{{ archiveNotice() }}</span>
        </div>
      }
      <div class="external-toolbar">
        <div>
          <h3>Time to Grow</h3>
          <span>Подтверждённые бронирования</span>
        </div>
        <div class="external-filters">
          <label
            >Клуб<select
              [(ngModel)]="externalClubId"
              (ngModelChange)="clubChanged()"
            >
              @for (club of externalClubs(); track club.id) {
                <option [value]="club.id">{{ club.name }}</option>
              }
            </select></label
          >
          @if (viewMode() === "list") {
            <label
              >Дата<input
                type="date"
                [(ngModel)]="externalDate"
                (ngModelChange)="loadExternal()"
            /></label>
          }
        </div>
      </div>
      @if (viewMode() === "calendar") {
        <div class="calendar-card">
          <div class="calendar-head">
            <button
              class="month-arrow"
              aria-label="Предыдущий месяц"
              (click)="changeMonth(-1)"
            >
              ‹
            </button>
            <div>
              <h3>{{ monthTitle() }}</h3>
              <span
                >{{ monthBookingCount() }}
                {{ bookingWord(monthBookingCount()) }}</span
              >
            </div>
            <button class="today-button" (click)="goToday()">Сегодня</button
            ><button
              class="month-arrow"
              aria-label="Следующий месяц"
              (click)="changeMonth(1)"
            >
              ›
            </button>
          </div>
          <div class="weekdays">
            @for (day of weekDays; track day) {
              <span>{{ day }}</span>
            }
          </div>
          @if (calendarLoading()) {
            <div class="calendar-loading">Загружаем бронирования за месяц…</div>
          }
          <div class="calendar-grid" [class.loading]="calendarLoading()">
            @for (day of calendarDays(); track day.key) {
              <button
                class="calendar-day"
                [class.outside]="!day.currentMonth"
                [class.today]="day.isToday"
                [class.selected]="day.key === externalDate"
                (click)="selectCalendarDay(day.key)"
              >
                <span class="day-number">{{ day.date.getDate() }}</span>
                @if (day.bookings.length) {
                  <span class="day-count"
                    >{{ day.bookings.length }}
                    {{ bookingWord(day.bookings.length) }}</span
                  ><span class="day-bookings">
                    @for (
                      booking of day.bookings.slice(0, 3);
                      track booking.id
                    ) {
                      <span class="mini-booking"
                        ><b>{{ booking.startsAt }}</b>
                        {{ booking.customerName }}</span
                      >
                    }
                    @if (day.bookings.length > 3) {
                      <small>+ ещё {{ day.bookings.length - 3 }}</small>
                    }
                  </span>
                }
              </button>
            }
          </div>
        </div>
      }
      @if (viewMode() === "list") {
        <div class="day-page-head">
          <button class="back-calendar" (click)="viewMode.set('calendar')">
            ← К календарю
          </button>
          <div>
            <span>Расписание на день</span>
            <h3>{{ selectedDateTitle() }}</h3>
          </div>
          <span class="day-total"
            >{{ externalBookings().length }}
            {{ bookingWord(externalBookings().length) }}</span
          >
        </div>
        @if (externalLoading()) {
          <p class="muted">Загружаем расписание…</p>
        }
        @if (externalError()) {
          <p class="error">{{ externalError() }}</p>
        }
        <div class="schedule external">
          @for (b of externalBookings(); track b.id) {
            <article [class.open]="expandedExternalId() === b.id">
              <div class="date">
                <b>{{ b.startsAt }}</b
                ><span>{{ b.endsAt }}</span>
              </div>
              <div class="booking-main">
                <strong>{{ b.customerName }}</strong
                ><span
                  >{{ b.zoneName }} · {{ b.productName }} ·
                  {{ b.players }} игроков · {{ b.amountCents / 100 }}
                  {{ b.currency }}</span
                ><small>{{
                  b.selectedGameName ||
                    b.suggestedGameName ||
                    "Игра выбирается на месте"
                }}</small>
              </div>
              <span class="pill" [class.paid]="b.paymentStatus === 'paid'">{{
                b.paymentStatusDisplay
              }}</span>
              <div class="external-actions">
                @if (b.sessionId) {
                  <span class="pill live">{{
                    sessionStatusLabel(b.sessionStatus)
                  }}</span>
                  @if (b.sessionStatus === "RUNNING") {
                    <button class="ghost" (click)="sessionExternal(b, 'PAUSE')">
                      Пауза
                    </button>
                  }
                  @if (b.sessionStatus === "PAUSED") {
                    <button
                      class="ghost"
                      (click)="sessionExternal(b, 'RESUME')"
                    >
                      Продолжить
                    </button>
                  }
                  @if (
                    b.sessionStatus !== "FINISHED" &&
                    b.sessionStatus !== "CANCELLED"
                  ) {
                    <button
                      class="danger"
                      (click)="sessionExternal(b, 'FINISH')"
                    >
                      Завершить
                    </button>
                  }
                } @else {
                  <select class="game-select" [(ngModel)]="selectedGames[b.id]">
                    <option value="">
                      {{
                        b.requiresGameSelection
                          ? "Выберите игру"
                          : "Оставить выбранную игру"
                      }}
                    </option>
                    @for (game of gamesForZone(b.zoneName); track game.id) {
                      <option [value]="game.id">{{ game.name }}</option>
                    }
                  </select>
                  <button
                    class="start-icon"
                    [disabled]="importingId() === b.id"
                    (click)="startExternal(b)"
                    aria-label="Начать игру"
                    title="Начать игру"
                  >
                    {{ importingId() === b.id ? "⋯" : "▶" }}
                  </button>
                }
                <button class="details-button" (click)="toggleExternal(b.id)">
                  {{ expandedExternalId() === b.id ? "Скрыть" : "Подробнее" }}
                </button>
                <button class="checkin-link-button" (click)="copyCheckInLink(b)">
                  {{ copiedCheckinId() === b.id ? "Ссылка скопирована ✓" : "Ссылка check-in" }}
                </button>
                <button class="checkin-qr-button" (click)="openCheckInQr(b)">
                  QR-код
                </button>
                <a class="open-checkin" [href]="b.checkInPath" target="_blank" rel="noopener" title="Открыть check-in">↗</a>
              </div>
              @if (expandedExternalId() === b.id) {
                <div class="booking-details">
                  <section>
                    <h4>Контакты бронирования</h4>
                    <dl>
                      <div>
                        <dt>Имя</dt>
                        <dd>{{ b.customerName }}</dd>
                      </div>
                      <div>
                        <dt>Телефон</dt>
                        <dd>{{ b.customerPhone || "—" }}</dd>
                      </div>
                      <div>
                        <dt>Email</dt>
                        <dd>{{ b.customerEmail || "—" }}</dd>
                      </div>
                      <div>
                        <dt>Оплата</dt>
                        <dd>
                          {{ b.paymentStatusDisplay }} ·
                          {{ b.amountCents / 100 }} {{ b.currency }}
                        </dd>
                      </div>
                    </dl>
                  </section>
                  <section>
                    <h4>
                      Прошли check-in
                      <span class="pill checkin"
                        >{{ b.checkedIn }}/{{ b.checkInTotal }}</span
                      >
                    </h4>
                    <div class="players">
                      @for (player of b.checkedInPlayers; track player.id) {
                        <div class="player">
                          <div class="player-title">
                            <strong>{{ player.name }}</strong>
                            @if (player.birthdayDaysAgo !== null) {
                              <span class="birthday">{{
                                birthdayLabel(player.birthdayDaysAgo)
                              }}</span>
                            }
                          </div>
                          <span>{{
                            player.phone ||
                              player.email ||
                              "Контакты не указаны"
                          }}</span
                          ><small
                            >{{
                              player.age !== null
                                ? ageLabel(player.age)
                                : "Возраст не указан"
                            }}
                            · Waiver:
                            {{
                              player.waiverAccepted ? "принят" : "не принят"
                            }}</small
                          >
                        </div>
                      } @empty {
                        <p class="muted">
                          Персональные данные check-in пока отсутствуют.
                        </p>
                      }
                    </div>
                  </section>
                </div>
              }
            </article>
          } @empty {
            @if (!externalLoading() && !externalError()) {
              <div class="empty">
                <b>На эту дату бронирований нет</b
                ><span>Выберите другую дату.</span>
              </div>
            }
          }
        </div>
      }
      @if (error()) {
        <p class="error">{{ error() }}</p>
      }
      <div class="schedule">
        @for (b of bookings(); track b.id) {
          <article>
            <div class="date">
              <b>{{ b.starts_at | date: "HH:mm" }}</b
              ><span>{{ b.starts_at | date: "dd MMM" }}</span>
            </div>
            <div class="booking-main">
              <strong>{{ b.customer_name }}</strong
              ><span
                >{{ b.room_name }} · {{ b.players }} игроков ·
                {{ b.amount_cents / 100 }} {{ b.currency }}</span
              >
            </div>
            <span class="pill">{{ b.payment_status }}</span>
            @if (b.session_id) {
              <div class="session-actions">
                <span class="pill live">{{ b.session_status }}</span>
                @if (b.session_status === "RUNNING") {
                  <button class="ghost" (click)="session(b, 'PAUSE')">
                    Пауза
                  </button>
                }
                @if (b.session_status === "PAUSED") {
                  <button class="ghost" (click)="session(b, 'RESUME')">
                    Продолжить
                  </button>
                }
                @if (b.session_status !== "FINISHED") {
                  <button class="danger" (click)="session(b, 'FINISH')">
                    Завершить
                  </button>
                }
              </div>
            } @else {
              <button
                class="start-icon"
                (click)="start(b)"
                aria-label="Начать игру"
                title="Начать игру"
              >
                ▶
              </button>
            }
          </article>
        }
      </div>
    </section>
  </main>
  @if (qrBooking(); as booking) {
    <div class="qr-backdrop" (click)="closeCheckInQr()">
      <div class="qr-dialog" role="dialog" aria-modal="true" aria-labelledby="checkin-qr-title" (click)="$event.stopPropagation()">
        <button class="qr-close" type="button" aria-label="Закрыть" (click)="closeCheckInQr()">×</button>
        <span class="qr-kicker">Персональный check-in</span>
        <h3 id="checkin-qr-title">{{ booking.customerName }}</h3>
        <p>{{ booking.date }} · {{ booking.startsAt }} · {{ booking.productName }}</p>
        <div class="qr-image-wrap">
          @if (qrLoading()) {
            <span>Создаём QR-код…</span>
          } @else if (checkInQrDataUrl()) {
            <img [src]="checkInQrDataUrl()" alt="QR-код защищённой ссылки check-in" />
          }
        </div>
        <strong class="qr-hint">Наведите камеру телефона — откроется check-in только этой брони</strong>
        <div class="qr-actions">
          <button type="button" (click)="copyCheckInLink(booking)">{{ copiedCheckinId() === booking.id ? "Ссылка скопирована ✓" : "Скопировать ссылку" }}</button>
          @if (checkInQrDataUrl()) {
            <a [href]="checkInQrDataUrl()" [download]="checkInQrFilename(booking)">Скачать PNG</a>
          }
        </div>
      </div>
    </div>
  }`,
  styles: [
    `
      .view-switch {
        display: flex;
        padding: 4px;
        background: #e9edf5;
        border-radius: 11px;
      }
      .view-switch button {
        padding: 8px 14px;
        background: transparent;
        color: #687386;
        box-shadow: none;
      }
      .view-switch button.active {
        background: #fff;
        color: var(--ink);
        box-shadow: 0 2px 8px #19213a15;
      }
      .archive-import {
        display: flex;
        align-items: end;
        gap: 12px;
        margin-top: 20px;
        padding: 14px 16px;
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 12px;
      }
      .archive-import strong {
        align-self: center;
      }
      .archive-import label {
        max-width: 170px;
      }
      .archive-import span {
        align-self: center;
        color: var(--muted);
      }
      .external-toolbar {
        display: flex;
        justify-content: space-between;
        align-items: end;
        margin-top: 24px;
      }
      .external-toolbar h3 {
        margin: 0;
      }
      .external-toolbar span,
      .muted {
        color: var(--muted);
      }
      .external-filters {
        display: flex;
        gap: 10px;
        align-items: end;
      }
      .external-toolbar label {
        max-width: 220px;
      }
      .calendar-card {
        position: relative;
        overflow: hidden;
        margin-top: 14px;
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 16px;
        box-shadow: 0 10px 30px #19213a0a;
      }
      .calendar-head {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 18px 20px;
        border-bottom: 1px solid var(--line);
      }
      .calendar-head div {
        flex: 1;
      }
      .calendar-head h3 {
        margin: 0;
        font-size: 20px;
        text-transform: capitalize;
      }
      .calendar-head span {
        display: block;
        margin-top: 3px;
        color: var(--muted);
        font-size: 12px;
      }
      .month-arrow,
      .today-button {
        box-shadow: none;
      }
      .month-arrow {
        display: grid;
        place-items: center;
        width: 38px;
        height: 38px;
        padding: 0;
        background: #f1f3f8;
        color: #344054;
        font-size: 26px;
      }
      .today-button {
        padding: 9px 13px;
        background: #eef0ff;
        color: var(--primary);
      }
      .weekdays,
      .calendar-grid {
        display: grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
      }
      .weekdays {
        padding: 0 10px;
        background: #fafbfc;
        border-bottom: 1px solid var(--line);
      }
      .weekdays span {
        padding: 10px;
        text-align: right;
        color: #8a94a6;
        font-size: 10px;
        font-weight: 800;
        text-transform: uppercase;
      }
      .calendar-grid.loading {
        opacity: 0.35;
      }
      .calendar-day {
        min-width: 0;
        min-height: 132px;
        padding: 10px;
        border-right: 1px solid var(--line);
        border-bottom: 1px solid var(--line);
        border-radius: 0;
        background: #fff;
        color: var(--ink);
        text-align: left;
        box-shadow: none;
      }
      .calendar-day:nth-child(7n) {
        border-right: 0;
      }
      .calendar-day:hover {
        z-index: 1;
        background: #fafbff;
        box-shadow: inset 0 0 0 2px #7c83ff55 !important;
        transform: none !important;
      }
      .calendar-day.outside {
        background: #fafbfc;
        color: #aab1bd;
      }
      .calendar-day.today .day-number {
        display: grid;
        place-items: center;
        width: 25px;
        height: 25px;
        margin: -3px -3px 4px auto;
        border-radius: 50%;
        background: var(--primary);
        color: #fff;
      }
      .calendar-day.selected {
        background: #f6f7ff;
        box-shadow: inset 0 0 0 2px #7c83ff;
      }
      .day-number {
        display: block;
        margin-bottom: 7px;
        text-align: right;
        font-weight: 800;
      }
      .day-count {
        display: block;
        margin-bottom: 6px;
        color: var(--primary);
        font-size: 10px;
        font-weight: 800;
      }
      .day-bookings {
        display: grid;
        gap: 4px;
      }
      .mini-booking {
        display: block;
        overflow: hidden;
        padding: 5px 6px;
        border-left: 3px solid #7c83ff;
        border-radius: 5px;
        background: #eef0ff;
        color: #4a5270;
        font-size: 9px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mini-booking b {
        color: #343c9b;
      }
      .day-bookings small {
        color: var(--muted);
        font-size: 9px;
      }
      .calendar-loading {
        position: absolute;
        z-index: 3;
        inset: 76px 0 auto;
        display: grid;
        place-items: center;
        height: 40px;
        background: #ffffffdd;
        color: var(--primary);
        font-weight: 700;
      }
      .day-page-head {
        display: flex;
        align-items: center;
        gap: 16px;
        margin-top: 18px;
        padding: 18px 20px;
        border: 1px solid #dfe3f4;
        border-radius: 14px;
        background: linear-gradient(135deg, #fff, #f7f8ff);
      }
      .day-page-head div { flex: 1; }
      .day-page-head div > span {
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .day-page-head h3 {
        margin: 4px 0 0;
        font-size: 22px;
        text-transform: capitalize;
      }
      .back-calendar {
        background: #eef0ff;
        color: var(--primary);
        box-shadow: none;
      }
      .day-total {
        padding: 8px 11px;
        border-radius: 999px;
        background: #e8f8ef;
        color: #087443;
        font-size: 11px;
        font-weight: 800;
      }
      .schedule {
        display: grid;
        gap: 10px;
        margin-top: 24px;
      }
      .schedule.external {
        margin-top: 12px;
        margin-bottom: 28px;
      }
      .schedule article {
        display: grid;
        grid-template-columns: 80px 1fr auto auto;
        gap: 16px;
        align-items: center;
        padding: 16px 18px;
        background: #fff;
        border: 1px solid var(--line);
        border-radius: 14px;
      }
      .schedule article.open {
        border-color: #b9c5ee;
        box-shadow: 0 8px 28px rgba(52, 72, 165, 0.08);
      }
      .date b,
      .date span,
      .booking-main strong,
      .booking-main span,
      .booking-main small {
        display: block;
      }
      .date b {
        font-size: 20px;
      }
      .date span,
      .booking-main span,
      .booking-main small {
        margin-top: 4px;
        color: var(--muted);
      }
      .pill {
        padding: 7px 10px;
        border-radius: 999px;
        background: #f2f4f7;
        font-size: 11px;
        font-weight: 700;
      }
      .pill.live,
      .pill.paid {
        background: #e8f8ef;
        color: #087443;
      }
      .pill.checkin {
        background: #eef4ff;
        color: #3448a5;
      }
      .external-actions {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .start-icon {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        padding: 0;
        font-size: 14px;
      }
      .game-select {
        min-width: 180px;
      }
      .details-button {
        background: #eef1f6;
        color: #344054;
        box-shadow: none;
      }
      .checkin-link-button {
        background: #fff0e9;
        color: #c43f08;
        box-shadow: none;
        white-space: nowrap;
      }
      .checkin-qr-button {
        background: #18243d;
        color: #fff;
        box-shadow: none;
        white-space: nowrap;
      }
      .open-checkin {
        display: grid;
        place-items: center;
        width: 40px;
        height: 40px;
        border: 1px solid #ffd0bb;
        border-radius: 9px;
        background: #fff8f4;
        color: #c43f08;
        text-decoration: none;
        font-weight: 800;
      }
      .qr-backdrop {
        position: fixed;
        z-index: 1000;
        inset: 0;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgba(10, 16, 28, 0.72);
        backdrop-filter: blur(8px);
      }
      .qr-dialog {
        position: relative;
        width: min(440px, 100%);
        max-height: calc(100vh - 32px);
        overflow: auto;
        padding: 30px;
        border-radius: 22px;
        background: #fff;
        box-shadow: 0 28px 90px rgba(10, 20, 40, 0.35);
        text-align: center;
      }
      .qr-close {
        position: absolute;
        top: 12px;
        right: 12px;
        width: 36px;
        height: 36px;
        padding: 0;
        border-radius: 50%;
        background: #eef1f6;
        color: #344054;
        box-shadow: none;
        font-size: 22px;
      }
      .qr-kicker {
        color: #df4d12;
        font-size: 10px;
        font-weight: 900;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .qr-dialog h3 {
        margin: 7px 34px 4px;
        color: #101828;
        font-size: 25px;
      }
      .qr-dialog > p {
        margin: 0 0 20px;
        color: #667085;
        font-size: 12px;
      }
      .qr-image-wrap {
        display: grid;
        place-items: center;
        width: min(310px, 100%);
        aspect-ratio: 1;
        margin: 0 auto;
        padding: 14px;
        border: 1px solid #e3e7ef;
        border-radius: 18px;
        background: #fff;
      }
      .qr-image-wrap img {
        display: block;
        width: 100%;
        height: auto;
      }
      .qr-image-wrap span {
        color: #667085;
        font-size: 12px;
      }
      .qr-hint {
        display: block;
        max-width: 320px;
        margin: 16px auto 20px;
        color: #475467;
        font-size: 12px;
        line-height: 1.5;
      }
      .qr-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      .qr-actions button,
      .qr-actions a {
        display: grid;
        place-items: center;
        min-height: 42px;
        padding: 10px 12px;
        border: 0;
        border-radius: 9px;
        background: #465eea;
        color: #fff;
        box-shadow: none;
        font-size: 11px;
        font-weight: 800;
        text-decoration: none;
      }
      .qr-actions a {
        background: #fff0e9;
        color: #c43f08;
      }
      .booking-details {
        grid-column: 1/-1;
        display: grid;
        grid-template-columns: minmax(240px, 0.8fr) minmax(320px, 1.2fr);
        gap: 24px;
        padding-top: 18px;
        border-top: 1px solid var(--line);
      }
      .booking-details section {
        min-width: 0;
      }
      .booking-details h4 {
        margin: 0 0 12px;
      }
      .booking-details h4 .pill {
        margin-left: 8px;
      }
      .booking-details dl {
        display: grid;
        gap: 9px;
        margin: 0;
      }
      .booking-details dl div {
        display: grid;
        grid-template-columns: 85px 1fr;
        gap: 10px;
      }
      .booking-details dt {
        color: var(--muted);
      }
      .booking-details dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      .players {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
      }
      .player {
        padding: 11px 12px;
        border-radius: 10px;
        background: #f7f8fb;
      }
      .player-title {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      .player strong,
      .player span,
      .player small {
        display: block;
      }
      .player span,
      .player small {
        margin-top: 3px;
        color: var(--muted);
        overflow-wrap: anywhere;
      }
      .player-title .birthday {
        margin: 0;
        padding: 4px 7px;
        border-radius: 999px;
        background: #fff1c7;
        color: #8a5b00;
        font-size: 9px;
        font-weight: 800;
        white-space: nowrap;
      }
      .session-actions {
        display: flex;
        align-items: center;
        gap: 7px;
      }
      .ghost {
        padding: 8px;
        background: #eef1f6;
        color: #344054;
        box-shadow: none;
      }
      @media (max-width: 900px) {
        .archive-import,
        .external-toolbar,
        .external-filters {
          align-items: stretch;
          flex-direction: column;
          gap: 12px;
        }
        .calendar-card {
          overflow-x: auto;
        }
        .weekdays,
        .calendar-grid {
          min-width: 760px;
        }
        .schedule article {
          grid-template-columns: 64px 1fr;
        }
        .schedule > article > button,
        .schedule > article > .pill,
        .external-actions,
        .session-actions {
          grid-column: 2;
          justify-self: start;
          flex-wrap: wrap;
        }
        .booking-details {
          grid-column: 1/-1;
          grid-template-columns: 1fr;
        }
        .players {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 700px) {
        header {
          flex-direction: column;
        }
        .view-switch {
          width: 100%;
        }
        .view-switch button {
          flex: 1;
        }
        .qr-dialog {
          padding: 26px 18px 20px;
        }
        .qr-actions {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
})
export class BookingsComponent {
  private http = inject(HttpClient);
  bookings = signal<Booking[]>([]);
  error = signal("");
  externalClubs = signal<ExternalClub[]>([]);
  externalClubId = "";
  externalBookings = signal<ExternalBooking[]>([]);
  externalLoading = signal(false);
  externalError = signal("");
  expandedExternalId = signal<string | null>(null);
  copiedCheckinId = signal<string | null>(null);
  qrBooking = signal<ExternalBooking | null>(null);
  checkInQrDataUrl = signal("");
  qrLoading = signal(false);
  importingId = signal<string | null>(null);
  externalDate = this.localDate(new Date());
  games = signal<Game[]>([]);
  selectedGames: Record<string, string> = {};
  archiveFrom = "2026-04-01";
  archiveTo = this.localDate(new Date());
  archiveLoading = signal(false);
  archiveNotice = signal("");
  viewMode = signal<"calendar" | "list">("calendar");
  calendarMonth = signal(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  calendarBookings = signal<Record<string, ExternalBooking[]>>({});
  calendarLoading = signal(false);
  weekDays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  constructor() {
    this.load();
    this.loadExternalClubs();
    this.http
      .get<Game[]>("/api/games")
      .subscribe({ next: (games) => this.games.set(games) });
  }
  private localDate(date: Date) {
    const offset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - offset).toISOString().slice(0, 10);
  }
  load() {
    this.http
      .get<Booking[]>("/api/bookings")
      .subscribe({
        next: (b) => this.bookings.set(b),
        error: () => this.error.set("Не удалось загрузить бронирования."),
      });
  }
  loadExternalClubs() {
    this.externalLoading.set(true);
    this.http
      .get<{ data: ExternalClub[]; defaultClubId: string | null }>(
        "/api/time-to-grow/clubs",
      )
      .subscribe({
        next: (r) => {
          this.externalClubs.set(r.data);
          this.externalClubId = r.defaultClubId || "";
          this.loadExternal();
          this.loadCalendar();
        },
        error: ({ status }) => {
          this.externalLoading.set(false);
          this.externalError.set(
            status === 503
              ? "Интеграция Time to Grow ещё не настроена."
              : "Не удалось загрузить клубы Time to Grow.",
          );
        },
      });
  }
  clubChanged() {
    this.loadExternal();
    this.loadCalendar();
  }
  monthTitle() {
    return new Intl.DateTimeFormat("ru-RU", {
      month: "long",
      year: "numeric",
    }).format(this.calendarMonth());
  }
  selectedDateTitle() {
    return new Intl.DateTimeFormat("ru-RU", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(`${this.externalDate}T12:00:00`));
  }
  monthBookingCount() {
    return Object.values(this.calendarBookings()).reduce(
      (sum, items) => sum + items.length,
      0,
    );
  }
  bookingWord(count: number) {
    const mod10 = count % 10,
      mod100 = count % 100;
    return mod10 === 1 && mod100 !== 11
      ? "бронь"
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? "брони"
        : "броней";
  }
  calendarDays() {
    const month = this.calendarMonth(),
      first = new Date(month.getFullYear(), month.getMonth(), 1),
      start = new Date(first);
    start.setDate(1 - ((first.getDay() + 6) % 7));
    const today = this.localDate(new Date());
    return Array.from({ length: 42 }, (_, index) => {
      const date = new Date(start);
      date.setDate(start.getDate() + index);
      const key = this.localDate(date);
      return {
        date,
        key,
        currentMonth: date.getMonth() === month.getMonth(),
        isToday: key === today,
        bookings: this.calendarBookings()[key] || [],
      };
    });
  }
  changeMonth(offset: number) {
    const month = this.calendarMonth();
    this.calendarMonth.set(
      new Date(month.getFullYear(), month.getMonth() + offset, 1),
    );
    this.loadCalendar();
  }
  goToday() {
    const now = new Date();
    this.calendarMonth.set(new Date(now.getFullYear(), now.getMonth(), 1));
    this.loadCalendar();
  }
  selectCalendarDay(date: string) {
    this.externalDate = date;
    this.viewMode.set("list");
    this.loadExternal();
  }
  loadCalendar() {
    if (!this.externalClubId) return;
    const month = this.calendarMonth(),
      days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    this.calendarLoading.set(true);
    this.externalError.set("");
    const requests = Array.from({ length: days }, (_, index) => {
      const date = this.localDate(
        new Date(month.getFullYear(), month.getMonth(), index + 1),
      );
      return this.http
        .get<{ data: ExternalBooking[] }>(
          `/api/time-to-grow/bookings?date=${date}&clubId=${encodeURIComponent(this.externalClubId)}`,
        )
        .pipe(catchError(() => of({ data: [] })));
    });
    forkJoin(requests).subscribe({
      next: (responses) => {
        const byDate: Record<string, ExternalBooking[]> = {};
        responses.forEach((response, index) => {
          const date = this.localDate(
            new Date(month.getFullYear(), month.getMonth(), index + 1),
          );
          byDate[date] = response.data;
        });
        this.calendarBookings.set(byDate);
        this.calendarLoading.set(false);
      },
      error: () => {
        this.calendarLoading.set(false);
        this.externalError.set("Не удалось загрузить календарь бронирований.");
      },
    });
  }
  loadExternal() {
    if (!this.externalDate || !this.externalClubId) return;
    this.expandedExternalId.set(null);
    this.externalLoading.set(true);
    this.externalError.set("");
    this.http
      .get<{ data: ExternalBooking[] }>(
        `/api/time-to-grow/bookings?date=${encodeURIComponent(this.externalDate)}&clubId=${encodeURIComponent(this.externalClubId)}`,
      )
      .subscribe({
        next: (r) => {
          this.externalBookings.set(r.data);
          this.externalLoading.set(false);
        },
        error: ({ status }) => {
          this.externalBookings.set([]);
          this.externalLoading.set(false);
          this.externalError.set(
            status === 503
              ? "Интеграция Time to Grow ещё не настроена."
              : "Не удалось загрузить бронирования Time to Grow.",
          );
        },
      });
  }
  toggleExternal(id: string) {
    this.expandedExternalId.update((current) => (current === id ? null : id));
  }
  async copyCheckInLink(booking: ExternalBooking) {
    const link = new URL(booking.checkInPath, location.origin).toString();
    try {
      await navigator.clipboard.writeText(link);
      this.copiedCheckinId.set(booking.id);
      window.setTimeout(() => {
        if (this.copiedCheckinId() === booking.id) this.copiedCheckinId.set(null);
      }, 2500);
    } catch {
      this.externalError.set("Не удалось скопировать ссылку. Откройте её кнопкой ↗.");
    }
  }
  async openCheckInQr(booking: ExternalBooking) {
    this.qrBooking.set(booking);
    this.checkInQrDataUrl.set("");
    this.qrLoading.set(true);
    const link = new URL(booking.checkInPath, location.origin).toString();
    try {
      const dataUrl = await QRCode.toDataURL(link, {
        width: 720,
        margin: 2,
        errorCorrectionLevel: "H",
        color: { dark: "#101828", light: "#ffffff" },
      });
      if (this.qrBooking()?.id === booking.id) this.checkInQrDataUrl.set(dataUrl);
    } catch {
      this.externalError.set("Не удалось создать QR-код.");
      this.closeCheckInQr();
    } finally {
      if (this.qrBooking()?.id === booking.id) this.qrLoading.set(false);
    }
  }
  closeCheckInQr() {
    this.qrBooking.set(null);
    this.checkInQrDataUrl.set("");
    this.qrLoading.set(false);
  }
  checkInQrFilename(booking: ExternalBooking) {
    const customer = booking.customerName.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, "-").replace(/^-|-$/g, "");
    return `check-in-${booking.date}-${booking.startsAt.replace(":", "-")}-${customer || "guest"}.png`;
  }
  ageLabel(age: number) {
    const mod10 = age % 10,
      mod100 = age % 100;
    const word =
      mod10 === 1 && mod100 !== 11
        ? "год"
        : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
          ? "года"
          : "лет";
    return `${age} ${word}`;
  }
  birthdayLabel(daysAgo: number) {
    return daysAgo === 0
      ? "🎂 День рождения сегодня"
      : daysAgo === 1
        ? "🎂 День рождения вчера"
        : `🎂 День рождения ${daysAgo} дн. назад`;
  }
  sessionStatusLabel(status: string | null) {
    return status === "RUNNING"
      ? "Игра идёт"
      : status === "PAUSED"
        ? "Пауза"
        : status === "FINISHED"
          ? "Завершена"
          : status === "CANCELLED"
            ? "Отменена"
            : "Сессия";
  }
  gamesForZone(zoneName: string) {
    return this.games().filter(
      (game) => game.room_name.toLowerCase() === zoneName.toLowerCase(),
    );
  }
  startExternal(b: ExternalBooking) {
    const selectedGameId = this.selectedGames[b.id] || null;
    if (b.requiresGameSelection && !selectedGameId) {
      this.externalError.set("Выберите фактическую VR-игру перед запуском.");
      return;
    }
    this.importingId.set(b.id);
    this.externalError.set("");
    this.http
      .post<{ items: { bookingId: string; gameId: string | null }[] }>(
        "/api/time-to-grow/import",
        {
          clubId: this.externalClubId,
          dates: [b.date],
          bookingId: b.id,
          createSessions: false,
        },
      )
      .subscribe({
        next: (result) => {
          const item = result.items[0];
          if (!item?.bookingId) {
            this.importingId.set(null);
            this.externalError.set("Бронь не удалось импортировать.");
            return;
          }
          this.http
            .post("/api/sessions", {
              bookingId: item.bookingId,
              gameId: selectedGameId || item.gameId,
              durationSeconds: 3600,
            })
            .subscribe({
              next: () => {
                this.importingId.set(null);
                this.loadExternal();
              },
              error: () => {
                this.importingId.set(null);
                this.externalError.set(
                  "Бронь импортирована, но сессию запустить не удалось.",
                );
              },
            });
        },
        error: () => {
          this.importingId.set(null);
          this.externalError.set(
            "Не удалось импортировать бронь Time to Grow.",
          );
        },
      });
  }
  sessionExternal(b: ExternalBooking, action: "PAUSE" | "RESUME" | "FINISH") {
    if (!b.sessionId) return;
    this.http
      .patch(`/api/sessions/${b.sessionId}`, { action })
      .subscribe({
        next: () => this.loadExternal(),
        error: () =>
          this.externalError.set("Не удалось изменить состояние сессии."),
      });
  }
  importArchive() {
    if (!this.externalClubId || this.archiveFrom > this.archiveTo) return;
    const dates: string[] = [];
    for (
      let date = new Date(`${this.archiveFrom}T00:00:00Z`),
        end = new Date(`${this.archiveTo}T00:00:00Z`);
      date <= end;
      date = new Date(date.getTime() + 86_400_000)
    )
      dates.push(date.toISOString().slice(0, 10));
    this.archiveLoading.set(true);
    this.archiveNotice.set("");
    this.http
      .post<{
        imported: number;
        failedDates: { date: string }[];
        failedBookings: { externalId: string }[];
      }>("/api/time-to-grow/import", {
        clubId: this.externalClubId,
        dates,
        createSessions: true,
      })
      .subscribe({
        next: (result) => {
          this.archiveLoading.set(false);
          const failed =
            result.failedDates.length + result.failedBookings.length;
          this.archiveNotice.set(
            `Импортировано броней: ${result.imported}${failed ? ` · ошибок: ${failed}` : ""}`,
          );
          this.load();
        },
        error: () => {
          this.archiveLoading.set(false);
          this.archiveNotice.set("Импорт не выполнен.");
        },
      });
  }
  isManagement() {
    try {
      return ["OWNER", "ADMIN"].includes(
        JSON.parse(
          atob((sessionStorage.getItem("access_token") || "").split(".")[1]),
        ).role,
      );
    } catch {
      return false;
    }
  }
  start(b: Booking) {
    this.http
      .post("/api/sessions", { bookingId: b.id, durationSeconds: 3600 })
      .subscribe({
        next: () => this.load(),
        error: () => this.error.set("Не удалось запустить игровую сессию."),
      });
  }
  session(b: Booking, action: "PAUSE" | "RESUME" | "FINISH") {
    this.http
      .patch(`/api/sessions/${b.session_id}`, { action })
      .subscribe({
        next: () => this.load(),
        error: () => this.error.set("Не удалось изменить состояние сессии."),
      });
  }
}
