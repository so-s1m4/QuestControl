import { Component, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
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
  confirmed: boolean;
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
type CheckInError = {
  code: string;
  participantNumber: number | null;
  fields: string[];
  upstreamStatus: number | null;
  requestId: string;
  createdAt: string;
};
type Game = {
  id: string;
  name: string;
  room_id: string;
  room_name: string;
  location_id: string;
  location_external_id: string | null;
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
  checkInErrors: CheckInError[];
  checkedInPlayers: CheckedInPlayer[];
  confirmed: boolean;
};
type ExternalClub = {
  id: string;
  name: string;
  timezone: string;
  address: string | null;
};
type SessionInventoryItem={id:string;name:string;category:string;unit:string;quantity:number;game_id:string|null;recommended:boolean};

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
        ><a class="sessions-nav" routerLink="/work-schedules">Графики работы</a
        ><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a
        ><a routerLink="/cameras">Камеры</a
        ><a routerLink="/inventory">Инвентарь</a
        ><a routerLink="/users">Пользователи</a>
      </nav>
    </aside>
    <section>
      <div class="mobile-booking-controls">
        <label>Клуб<select [(ngModel)]="externalClubId" (ngModelChange)="clubChanged()">
          @for (club of externalClubs(); track club.id) {
            <option [value]="club.id">{{ club.name }}</option>
          }
        </select></label>
        <label>Дата<input type="date" [(ngModel)]="externalDate" (ngModelChange)="loadExternal()" /></label>
      </div>
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
        <div class="archive-import" [class.mobile-open]="showArchiveImport()">
          <strong>Импорт истории</strong>
          <button class="archive-close" type="button" aria-label="Закрыть импорт истории" (click)="closeArchiveImport()">×</button
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
            <article
              class="booking-card"
              [class.open]="expandedExternalId() === b.id"
              role="button"
              tabindex="0"
              [attr.aria-expanded]="expandedExternalId() === b.id"
              (click)="toggleExternalFromCard($event, b.id)"
              (keydown.enter)="toggleExternalFromCard($event, b.id)"
              (keydown.space)="toggleExternalFromCard($event, b.id)"
            >
              <div class="date">
                <b>{{ b.startsAt }}</b
                ><span>{{ b.endsAt }}</span>
                <span class="pill payment-pill" [class.paid]="b.paymentStatus === 'paid'" [class.unpaid]="b.paymentStatus !== 'paid'">
                  {{ b.paymentStatus === "paid" ? "Paid" : "Not Paid" }}
                </span>
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
              <button class="confirmation" [class.confirmed]="b.confirmed" [disabled]="confirmingId() === b.id" (click)="toggleExternalConfirmation(b)">
                {{ b.confirmed ? "Подтверждено" : "Не подтверждено" }}
              </button>
              <span class="card-chevron" aria-hidden="true">⌄</span>
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
                    @if (b.checkInErrors.length) {
                      <div class="checkin-errors">
                        <strong>Ошибки отправки за последние 14 дней</strong>
                        @for (failure of b.checkInErrors; track failure.requestId) {
                          <div class="checkin-error-row">
                            <span>{{ checkInErrorLabel(failure) }}</span>
                            <small>{{ failure.createdAt | date:"dd.MM, HH:mm" }} · ID {{ failure.requestId }}</small>
                          </div>
                        }
                      </div>
                    }
                  </section>
                  <section class="booking-controls">
                    <h4>Управление бронью</h4>
                    <div class="control-group">
                      <span>Check-in гостей</span>
                      <button class="checkin-qr-button" (click)="openCheckInQr(b)">Показать QR-код</button>
                      <button class="checkin-link-button" (click)="copyCheckInLink(b)">{{ copiedCheckinId() === b.id ? "Ссылка скопирована ✓" : "Скопировать ссылку" }}</button>
                      <a class="control-link" [href]="checkInUrl(b)" target="_blank" rel="noopener">Открыть check-in ↗</a>
                    </div>
                    <div class="control-group extra-guests-control">
                      <span>Больше гостей</span>
                      <p>В брони: {{ b.players }}. Укажите итоговое количество пришедших гостей.</p>
                      <label>Всего гостей
                        <input type="number" [min]="b.players + 1" step="1" [(ngModel)]="extraGuestTotals[b.id]" [disabled]="extraGuestBusyId() === b.id" />
                      </label>
                      <button class="extra-guests-button" type="button" (click)="authorizeExtraGuests(b)" [disabled]="extraGuestBusyId() === b.id">
                        {{ extraGuestBusyId() === b.id ? "Разрешаем…" : "Разрешить check-in" }}
                      </button>
                      @if (extraGuestMessage(b.id); as message) { <small [class.error-text]="extraGuestError(b.id)">{{ message }}</small> }
                    </div>
                    <div class="control-group">
                      <span>Игровая сессия</span>
                      @if (b.sessionId) {
                        <div class="session-state"><span class="pill live">{{ sessionStatusLabel(b.sessionStatus) }}</span></div>
                        @if (b.sessionStatus === "RUNNING") {
                          <button class="ghost" (click)="sessionExternal(b, 'PAUSE')">Поставить на паузу</button>
                        }
                        @if (b.sessionStatus === "PAUSED") {
                          <button class="ghost" (click)="sessionExternal(b, 'RESUME')">Продолжить сессию</button>
                        }
                        @if (b.sessionStatus !== "FINISHED" && b.sessionStatus !== "CANCELLED") {
                          <button class="danger" (click)="sessionExternal(b, 'FINISH')">Завершить сессию</button>
                        }
                      } @else {
                        <button class="start-session" (click)="openSessionRecord(b)">Записать игру</button>
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
            <button class="confirmation" [class.confirmed]="b.confirmed" [disabled]="confirmingId() === b.id" (click)="toggleConfirmation(b)">{{ b.confirmed ? "Подтверждено" : "Не подтверждено" }}</button>
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
  }
  @if(recordBooking();as booking){<div class="record-backdrop" (click)="closeSessionRecord()"><section class="record-dialog" role="dialog" aria-modal="true" aria-labelledby="record-title" (click)="$event.stopPropagation()">
    <header><div><small>Завершённая сессия</small><h3 id="record-title">Записать игру</h3><p>{{booking.customerName}} · {{booking.date}}</p></div><button type="button" aria-label="Закрыть" (click)="closeSessionRecord()">×</button></header>
    <div class="record-form">
      <div class="game-picker"><div class="picker-title"><b>Какая игра?</b>@if(selectedGameName()){<span>✓ {{selectedGameName()}}</span>}</div><input type="search" [(ngModel)]="gameSearch" placeholder="Найти игру…"><div class="game-options">@for(game of filteredRecordGames(booking);track game.id){<button type="button" [class.selected]="recordDraft.gameId===game.id" (click)="selectRecordGame(game)">{{game.name}}</button>}@empty{<p>Игра не найдена</p>}</div></div>
      <label>Игроков<input type="number" min="0" step="1" [(ngModel)]="recordDraft.playerCount"></label><label>Начало<input type="datetime-local" [(ngModel)]="recordDraft.startedAt"></label><label>Окончание<input type="datetime-local" [(ngModel)]="recordDraft.endedAt"></label><div class="record-duration"><span>Фактическая длительность</span><b>{{recordDuration()}}</b></div>
      <div class="magnet-title"><div><h4>Магниты</h4><p>{{deductionTotal()===0?'Без списания':deductionSummary()}}</p></div><b [class.complete]="deductionTotal()===recordDraft.playerCount">{{deductionTotal()}} / {{recordDraft.playerCount}}</b></div>
      <div class="magnet-suggestion">@if(deductionTotal()){<div class="chosen-magnets">@for(item of selectedMagnetItems();track item.id){<span><b>{{recordDeductions[item.id]}}×</b> {{item.name}}</span>}</div>}@else{<span>Магниты списываться не будут</span>}<button type="button" class="secondary" (click)="magnetEditorOpen.set(!magnetEditorOpen())">{{magnetEditorOpen()?'Готово':'Изменить списание'}}</button></div>
      @if(magnetEditorOpen()){<div class="magnet-list">@for(item of sessionInventory();track item.id){<div [class.recommended]="item.recommended"><span><b>{{item.name}}</b><small>{{item.recommended?'Подходит к игре · ':''}}остаток {{item.quantity}} {{item.unit}}</small></span><div class="stepper"><button type="button" (click)="changeDeduction(item,-1)">−</button><b>{{recordDeductions[item.id]||0}}</b><button type="button" (click)="changeDeduction(item,1)">+</button></div></div>}@empty{<p>На этой локации магнитов на складе нет.</p>}<button type="button" class="no-deduction" (click)="clearDeductions()">Не списывать магниты</button></div>}
      @if(recordError()){<p class="record-error">{{recordError()}}</p>}<footer><button type="button" class="secondary" (click)="closeSessionRecord()">Отмена</button><button type="button" [disabled]="recordSaving()" (click)="saveSessionRecord()">{{recordSaving()?'Записываем…':'Записать сессию'}}</button></footer>
    </div></section></div>}
  `,
  styles: [
    `
      .view-switch {
        display: flex;
        padding: 4px;
        background: #e9edf5;
        border-radius: 11px;
      }
      .mobile-booking-controls { display: none; }
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
      .archive-close { display: none; }
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
      .schedule.external article {
        min-width: 0;
        overflow: hidden;
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
      .schedule.external article {
        grid-template-columns: 80px 1fr auto auto;
      }
      .schedule article.open {
        border-color: #b9c5ee;
        box-shadow: 0 8px 28px rgba(52, 72, 165, 0.08);
      }
      .schedule.external .booking-card {
        cursor: pointer;
        transition: border-color .18s, box-shadow .18s, background .18s;
      }
      .schedule.external .booking-card:hover {
        border-color: #cbd3e7;
        background: #fcfcfe;
      }
      .schedule.external .booking-card:focus-visible {
        outline: 3px solid #7c83ff38;
        outline-offset: 2px;
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
      .confirmation { padding: 8px 11px; background: #fff1f0; border: 1px solid #f3c4c0; box-shadow: none; color: #b42318; font-size: 10px; white-space: nowrap; }
      .confirmation.confirmed { background: #e8f8ef; border-color: #a6dfbf; color: #087443; }
      .pill.checkin {
        background: #eef4ff;
        color: #3448a5;
      }
      .date .payment-pill {
        display: inline-flex;
        width: fit-content;
        margin-top: 9px;
        padding: 5px 7px;
        color: #087443;
        font-size: 8px;
        font-weight: 900;
        line-height: 1;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .date .payment-pill.paid {
        border: 1px solid #a6dfbf;
        background: #e8f8ef;
      }
      .date .payment-pill.unpaid {
        border: 1px solid #e8ad00;
        background: #ffe052;
        box-shadow: 0 0 0 2px #ffd4262b, 0 3px 9px #d99b0030;
        color: #5b3a00;
      }
      .card-chevron {
        display: grid;
        place-items: center;
        width: 34px;
        height: 34px;
        border-radius: 50%;
        background: #f0f2f6;
        color: #667085;
        font-size: 20px;
        line-height: 1;
        transition: transform .18s, background .18s;
      }
      article.open .card-chevron {
        background: #e9ecff;
        color: var(--primary);
        transform: rotate(180deg);
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
      .extra-guests-control { background: #fff9ed; border-color: #f1d3a6; }
      .extra-guests-control p { margin: 0; color: #795619; font-size: 11px; line-height: 1.4; }
      .extra-guests-control label { display: grid; gap: 5px; color: #795619; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; }
      .extra-guests-control input { width: 100%; min-height: 38px; box-sizing: border-box; border: 1px solid #e3bd80; border-radius: 8px; background: #fff; padding: 8px 10px; color: #344054; font-size: 14px; font-weight: 700; }
      .extra-guests-button { background: #b54708; color: #fff; box-shadow: none; }
      .extra-guests-control small { color: #087443; font-size: 10px; line-height: 1.4; }
      .extra-guests-control small.error-text { color: #b42318; }
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
        grid-template-columns: minmax(210px, 0.75fr) minmax(300px, 1.15fr) minmax(220px, 0.75fr);
        gap: 24px;
        padding-top: 18px;
        border-top: 1px solid var(--line);
      }
      .booking-details > section {
        min-width: 0;
        width: auto;
        max-width: none;
        margin: 0;
        padding: 0;
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
      .booking-controls {
        padding-left: 24px !important;
        border-left: 1px solid var(--line);
      }
      .control-group {
        display: grid;
        gap: 8px;
        margin-top: 10px;
        padding: 13px;
        border: 1px solid #e7eaf0;
        border-radius: 11px;
        background: #f8f9fb;
      }
      .control-group > span {
        margin-bottom: 2px;
        color: #667085;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .control-group button,
      .control-link,
      .control-group select {
        width: 100%;
        min-height: 38px;
      }
      .control-link {
        display: grid;
        place-items: center;
        border: 1px solid #d9deea;
        border-radius: 8px;
        background: #fff;
        color: #344054;
        font-size: 11px;
        font-weight: 700;
        text-decoration: none;
      }
      .start-session {
        background: #465eea;
        color: #fff;
        box-shadow: none;
      }
      .session-state {
        display: flex;
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
      .checkin-errors {
        display: grid;
        gap: 7px;
        grid-column: 1/-1;
        margin-top: 10px;
        padding: 12px;
        border: 1px solid #f0b59f;
        border-radius: 10px;
        background: #fff7f3;
      }
      .checkin-errors > strong { color: #9b3416; font-size: 11px; }
      .checkin-error-row { padding-top: 7px; border-top: 1px solid #f3d7cd; }
      .checkin-error-row span,.checkin-error-row small { display: block; }
      .checkin-error-row span { color: #6e2b16; font-size: 11px; font-weight: 700; }
      .checkin-error-row small { margin-top: 3px; color: #8b6d63; overflow-wrap: anywhere; }
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
        .schedule.external article {
          grid-template-columns: 64px minmax(0, 1fr) auto 34px;
        }
        .schedule > article > button,
        .schedule > article > .pill,
        .session-actions {
          grid-column: 2;
          justify-self: start;
          flex-wrap: wrap;
        }
        .booking-details {
          grid-column: 1/-1;
          grid-template-columns: 1fr;
        }
        .booking-controls {
          padding: 18px 0 0 !important;
          border-top: 1px solid var(--line);
          border-left: 0;
        }
        .players {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 760px) {
        main > section > header,
        .external-toolbar,
        .day-page-head { display: none; }
        .mobile-booking-controls {
          position: sticky;
          z-index: 15;
          top: 0;
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          width: 100%;
          max-width: 100%;
          overflow: hidden;
          gap: 8px;
          margin: -4px -2px 12px;
          padding: 10px;
          border: 1px solid #e1e5ed;
          border-radius: 14px;
          background: #f4f6faed;
          box-shadow: 0 8px 24px #19213a0d;
          backdrop-filter: blur(14px);
        }
        .mobile-booking-controls label { min-width: 0; max-width: 100%; overflow: hidden; gap: 5px; color: #788295; font-size: 9px; text-transform: uppercase; letter-spacing: .06em; }
        .mobile-booking-controls input,
        .mobile-booking-controls select { display: block; min-width: 0; max-width: 100%; min-height: 42px; padding: 9px 10px; border-color: #d8dde7; background: #fff; font-size: 14px !important; text-transform: none; letter-spacing: 0; }
        .mobile-booking-controls input[type="date"] { width: 100%; appearance: none; -webkit-appearance: none; }
        .mobile-booking-controls input[type="date"]::-webkit-date-and-time-value { min-width: 0; text-align: left; }
        .archive-import {
          display: none;
        }
        .archive-import.mobile-open {
          position: relative;
          display: flex;
          margin-top: 16px;
          padding-top: 48px;
        }
        .archive-import.mobile-open strong {
          position: absolute;
          top: 18px;
          left: 16px;
        }
        .archive-import.mobile-open .archive-close {
          position: absolute;
          top: 9px;
          right: 9px;
          display: grid;
          width: 36px;
          min-height: 36px;
          padding: 0;
          place-items: center;
          border-radius: 50%;
          background: #eef1f6;
          box-shadow: none;
          color: #344054;
          font-size: 21px;
        }
        .qr-dialog {
          padding: 26px 18px 20px;
        }
        .qr-actions {
          grid-template-columns: 1fr;
        }
        .archive-import,
        .external-toolbar,
        .external-filters {
          width: 100%;
        }
        .archive-import button,
        .external-filters label,
        .external-filters input,
        .external-filters select {
          width: 100%;
        }
        .calendar-head {
          display: grid;
          grid-template-columns: 42px minmax(0, 1fr) 42px;
          padding: 14px 10px;
        }
        .calendar-head > div {
          grid-column: 2;
          grid-row: 1;
          min-width: 0;
          text-align: center;
        }
        .calendar-head .today-button {
          grid-column: 1/-1;
          grid-row: 2;
          width: 100%;
        }
        .calendar-head .month-arrow:last-child {
          grid-column: 3;
          grid-row: 1;
        }
        .day-page-head {
          display: grid;
          align-items: stretch;
          grid-template-columns: 1fr;
        }
        .day-total {
          justify-self: start;
        }
        .schedule article {
          grid-template-columns: 58px minmax(0, 1fr);
          padding: 15px 13px;
        }
        .schedule.external article {
          grid-template-columns: 66px minmax(0, 1fr) 34px;
        }
        .schedule.external .confirmation { grid-column: 2; justify-self: start; }
        .schedule.external .card-chevron { grid-column: 3; grid-row: 1; }
        .schedule.external .booking-card { align-items: start; }
        .schedule.external .booking-main { padding-top: 1px; }
        .schedule.external .card-chevron { align-self: start; }
        .booking-main span,
        .booking-main small,
        .booking-details dd {
          overflow-wrap: anywhere;
        }
        .schedule > article > button,
        .schedule > article > .pill,
        .session-actions {
          width: 100%;
          justify-content: center;
        }
        .booking-details {
          grid-column: 1/-1;
          gap: 18px;
          padding-top: 18px;
        }
        .booking-details > section {
          min-width: 0;
        }
        .booking-controls button,
        .booking-controls .control-link,
      .booking-controls select {
          width: 100%;
          min-height: 44px;
        }
      }
      .record-backdrop{position:fixed;z-index:2200;inset:0;display:grid;place-items:center;padding:18px;background:#101828aa;backdrop-filter:blur(5px)}.record-dialog{width:min(650px,100%);max-height:calc(100vh - 36px);overflow:auto;border-radius:20px;background:#fff;box-shadow:0 30px 90px #10182855}.record-dialog>header{display:flex;justify-content:space-between;padding:24px 26px 18px;border-bottom:1px solid #eaecf0}.record-dialog>header small{color:#4f46e5;font-weight:800;text-transform:uppercase}.record-dialog h3{margin:4px 0;font-size:23px}.record-dialog header p{margin:0;color:#667085}.record-dialog>header button{padding:0;width:36px;height:36px;background:#f2f4f7;color:#475467;box-shadow:none;font-size:23px}.record-form{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:22px 26px}.record-form label{display:grid;gap:6px;font-weight:700}.record-duration{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-radius:11px;background:#f5f7fa}.magnet-title{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;margin-top:5px}.magnet-title h4,.magnet-title p{margin:0}.magnet-title p{margin-top:3px;color:#667085;font-size:11px}.magnet-title>b{padding:7px 10px;border-radius:9px;background:#fff1f2;color:#b42318}.magnet-title>b.complete{background:#ecfdf3;color:#067647}.magnet-list{grid-column:1/-1;display:grid;gap:7px}.magnet-list>label{display:grid;grid-template-columns:1fr 90px;align-items:center;padding:11px 13px;border:1px solid #e4e7ec;border-radius:11px}.magnet-list>label.recommended{border-color:#a7c8ff;background:#f5f8ff}.magnet-list span b,.magnet-list span small{display:block}.magnet-list span small{margin-top:3px;color:#667085;font-weight:400}.record-error{grid-column:1/-1;margin:0;color:#b42318}.record-form footer{grid-column:1/-1;display:flex;justify-content:flex-end;gap:9px;padding-top:8px}@media(max-width:650px){.record-form{grid-template-columns:1fr;padding:18px}.record-form>*{grid-column:1/-1}.record-dialog>header{padding:20px 18px}}
      .game-picker{grid-column:1/-1}.picker-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.picker-title>span{padding:5px 8px;border-radius:8px;background:#ecfdf3;color:#067647;font-size:10px;font-weight:800}.game-options{display:flex;max-height:146px;flex-wrap:wrap;gap:7px;overflow:auto;margin-top:8px;padding:2px}.game-options button{padding:8px 11px;border:1px solid #e1e5ec;background:#fff;box-shadow:none;color:#475467}.game-options button.selected{border-color:#5d63dc;background:#eef0ff;color:#3f43b5;box-shadow:0 0 0 2px #6c72e51c}.magnet-suggestion{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px;border:1px solid #dfe4ec;border-radius:12px;background:#f8fafc}.chosen-magnets{display:flex;flex-wrap:wrap;gap:6px}.chosen-magnets span{padding:6px 9px;border-radius:8px;background:#eef0ff;color:#3f4784;font-size:11px}.magnet-list>div{display:grid;grid-template-columns:1fr auto;align-items:center;padding:10px 12px;border:1px solid #e4e7ec;border-radius:11px}.magnet-list>div.recommended{border-color:#a7c8ff;background:#f5f8ff}.stepper{display:grid;grid-template-columns:34px 34px 34px;align-items:center;text-align:center}.stepper button{width:34px;height:34px;padding:0;background:#eef1f6;box-shadow:none;color:#344054}.stepper b{font-size:14px}.no-deduction{justify-self:start;background:transparent;box-shadow:none;color:#b42318}
    `,
  ],
})
export class BookingsComponent {
  private http = inject(HttpClient);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
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
  extraGuestTotals: Record<string, number | null> = {};
  extraGuestAuthorizations = signal<Record<string, string>>({});
  extraGuestMessages = signal<Record<string, { text: string; error: boolean }>>({});
  extraGuestBusyId = signal<string | null>(null);
  importingId = signal<string | null>(null);
  recordBooking=signal<ExternalBooking|null>(null);
  sessionInventory=signal<SessionInventoryItem[]>([]);
  recordSaving=signal(false);recordError=signal("");recordDeductions:Record<string,number>={};
  magnetEditorOpen=signal(false);gameSearch="";
  recordDraft={gameId:"",startedAt:"",endedAt:"",playerCount:0};
  confirmingId = signal<string | null>(null);
  externalDate = this.localDate(new Date());
  games = signal<Game[]>([]);
  selectedGames: Record<string, string> = {};
  archiveFrom = "2026-04-01";
  archiveTo = this.localDate(new Date());
  archiveLoading = signal(false);
  archiveNotice = signal("");
  showArchiveImport = signal(false);
  viewMode = signal<"calendar" | "list">(
    typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches
      ? "list"
      : "calendar",
  );
  calendarMonth = signal(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );
  calendarBookings = signal<Record<string, ExternalBooking[]>>({});
  calendarLoading = signal(false);
  weekDays = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
  constructor() {
    this.route.queryParamMap.subscribe((params) => this.showArchiveImport.set(params.get("history") === "1"));
    this.load();
    this.loadExternalClubs();
    this.http
      .get<Game[]>("/api/games")
      .subscribe({ next: (games) => this.games.set(games) });
  }
  closeArchiveImport() {
    this.showArchiveImport.set(false);
    void this.router.navigate([], { relativeTo: this.route, queryParams: { history: null }, queryParamsHandling: "merge", replaceUrl: true });
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

  toggleExternalFromCard(event: Event, id: string) {
    const target = event.target as HTMLElement;
    const currentTarget = event.currentTarget as HTMLElement;
    if (target !== currentTarget && target.closest("button,a,input,select,textarea,label")) return;
    if (event instanceof KeyboardEvent) event.preventDefault();
    this.toggleExternal(id);
  }
  async copyCheckInLink(booking: ExternalBooking) {
    const link = this.checkInUrl(booking);
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
    const link = this.checkInUrl(booking);
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
  checkInUrl(booking: ExternalBooking) {
    const url = new URL(booking.checkInPath, location.origin);
    const authorization = this.extraGuestAuthorizations()[booking.id];
    if (authorization) url.searchParams.set("extraAuthorization", authorization);
    return url.toString();
  }
  extraGuestMessage(bookingId: string) { return this.extraGuestMessages()[bookingId]?.text || ""; }
  extraGuestError(bookingId: string) { return this.extraGuestMessages()[bookingId]?.error || false; }
  authorizeExtraGuests(booking: ExternalBooking) {
    const totalGuests = Number(this.extraGuestTotals[booking.id] ?? booking.players + 1);
    if (!Number.isInteger(totalGuests) || totalGuests <= booking.players) {
      this.extraGuestMessages.update(messages => ({ ...messages, [booking.id]: { text: `Укажите целое число больше ${booking.players}.`, error: true } }));
      return;
    }
    this.extraGuestBusyId.set(booking.id);
    this.extraGuestMessages.update(messages => ({ ...messages, [booking.id]: { text: "", error: false } }));
    this.http.post<{ extraAuthorization: string; maxGuests: number }>(`/api${booking.checkInPath}/extra-guests`, { totalGuests }).subscribe({
      next: ({ extraAuthorization, maxGuests: approvedTotal }) => {
        this.extraGuestTotals[booking.id] = approvedTotal;
        this.extraGuestAuthorizations.update(authorizations => ({ ...authorizations, [booking.id]: extraAuthorization }));
        this.extraGuestMessages.update(messages => ({ ...messages, [booking.id]: { text: `Разрешено до ${approvedTotal} гостей. QR-код и ссылка обновлены.`, error: false } }));
        this.extraGuestBusyId.set(null);
      },
      error: ({ error }) => {
        const text = error?.error === "LOCATION_FORBIDDEN" ? "У вас нет доступа к этому клубу." : "Не удалось выдать разрешение. Попробуйте ещё раз.";
        this.extraGuestMessages.update(messages => ({ ...messages, [booking.id]: { text, error: true } }));
        this.extraGuestBusyId.set(null);
      },
    });
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
  checkInErrorLabel(failure: CheckInError) {
    const labels: Record<string,string> = {
      INVALID_INPUT: `Некорректно заполнены поля${failure.fields.length ? `: ${failure.fields.join(", ")}` : ""}`,
      CHECKIN_LINK_INVALID: "Ссылка check-in недействительна или устарела",
      EXTRA_GUEST_AUTHORIZATION_REQUIRED: "Нет разрешения для дополнительного гостя",
      CHECKIN_PARTICIPANT_ALREADY_SUBMITTED: "Этот участник уже был отправлен",
      TIME_TO_GROW_SUBMISSION_FAILED: `Time to Grow отклонил данные${failure.upstreamStatus ? ` (HTTP ${failure.upstreamStatus})` : ""}`,
      TIME_TO_GROW_TIMEOUT: "Time to Grow не ответил вовремя",
      TIME_TO_GROW_NOT_CONFIGURED: "Интеграция Time to Grow не настроена",
      TIME_TO_GROW_REQUEST_FAILED: "Не удалось получить бронь из Time to Grow",
      TIME_TO_GROW_INVALID_RESPONSE: "Time to Grow вернул некорректный ответ",
    };
    const participant=failure.participantNumber?`Участник ${failure.participantNumber}: `:"";
    return participant+(labels[failure.code]||`Ошибка ${failure.code}`);
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
      (game) => game.room_name.toLowerCase() === zoneName.toLowerCase()
        && (!this.externalClubId || game.location_external_id === this.externalClubId),
    );
  }
  openSessionRecord(booking:ExternalBooking){
    const start=`${booking.date}T${booking.startsAt.slice(0,5)}`,endDate=booking.endsAt.slice(0,5)<booking.startsAt.slice(0,5)?this.localDate(new Date(new Date(`${booking.date}T12:00:00`).getTime()+86400000)):booking.date;
    this.recordBooking.set(booking);this.recordDraft={gameId:booking.gameId||this.gamesForZone(booking.zoneName).find(game=>game.name===booking.suggestedGameName)?.id||"",startedAt:start,endedAt:`${endDate}T${booking.endsAt.slice(0,5)}`,playerCount:booking.checkedIn};this.recordDeductions={};this.recordError.set("");this.gameSearch="";this.magnetEditorOpen.set(false);this.loadSessionInventory();
  }
  closeSessionRecord(){if(!this.recordSaving()){this.recordBooking.set(null);this.sessionInventory.set([])}}
  loadSessionInventory(){if(!this.recordBooking()||!this.externalClubId)return;const query=new URLSearchParams({clubId:this.externalClubId});if(this.recordDraft.gameId)query.set("gameId",this.recordDraft.gameId);this.http.get<SessionInventoryItem[]>(`/api/time-to-grow/session-record-options?${query}`).subscribe({next:items=>{this.sessionInventory.set(items);this.recordDeductions={};let remaining=this.recordDraft.playerCount;for(const item of items){if(remaining<=0)break;const quantity=Math.min(Number(item.quantity),remaining);if(quantity>0){this.recordDeductions[item.id]=quantity;remaining-=quantity}}},error:()=>this.recordError.set("Не удалось загрузить магниты со склада.")})}
  setDeduction(item:SessionInventoryItem,value:unknown){this.recordDeductions[item.id]=Math.max(0,Math.min(Math.floor(Number(value)||0),Number(item.quantity)))}
  filteredRecordGames(booking:ExternalBooking){const query=this.gameSearch.trim().toLowerCase();return this.gamesForZone(booking.zoneName).filter(game=>!query||game.name.toLowerCase().includes(query))}
  selectedGameName(){return this.games().find(game=>game.id===this.recordDraft.gameId)?.name||""}
  selectRecordGame(game:Game){this.recordDraft.gameId=game.id;this.loadSessionInventory()}
  changeDeduction(item:SessionInventoryItem,delta:number){this.setDeduction(item,(this.recordDeductions[item.id]||0)+delta)}
  clearDeductions(){this.recordDeductions={}}
  selectedMagnetItems(){return this.sessionInventory().filter(item=>(this.recordDeductions[item.id]||0)>0)}
  deductionSummary(){return this.selectedMagnetItems().map(item=>`${this.recordDeductions[item.id]}× ${item.name}`).join(" · ")}
  deductionTotal(){return Object.values(this.recordDeductions).reduce((sum,value)=>sum+value,0)}
  recordDuration(){const start=new Date(this.recordDraft.startedAt),end=new Date(this.recordDraft.endedAt),minutes=Math.round((end.getTime()-start.getTime())/60000);return Number.isFinite(minutes)&&minutes>0?`${Math.floor(minutes/60)} ч ${minutes%60} мин`:"—"}
  saveSessionRecord(){const booking=this.recordBooking();if(!booking)return;if(!this.recordDraft.gameId){this.recordError.set("Выберите игру.");return}if(new Date(this.recordDraft.endedAt)<=new Date(this.recordDraft.startedAt)){this.recordError.set("Окончание должно быть позже начала.");return}if(this.deductionTotal()!==0&&this.deductionTotal()!==this.recordDraft.playerCount){this.recordError.set("Спишите магниты для всех игроков или оставьте все значения нулевыми.");return}this.recordSaving.set(true);this.recordError.set("");const deductions=Object.entries(this.recordDeductions).filter(([,quantity])=>quantity>0).map(([itemId,quantity])=>({itemId,quantity}));this.http.post("/api/time-to-grow/sessions/record",{clubId:this.externalClubId,date:booking.date,bookingId:booking.id,gameId:this.recordDraft.gameId,startedAt:new Date(this.recordDraft.startedAt).toISOString(),endedAt:new Date(this.recordDraft.endedAt).toISOString(),playerCount:this.recordDraft.playerCount,deductions}).subscribe({next:()=>{this.recordSaving.set(false);this.closeSessionRecord();this.loadExternal()},error:({error})=>{this.recordSaving.set(false);this.recordError.set(error?.error==="SESSION_ALREADY_RECORDED"?"Для этой брони сессия уже записана.":error?.error==="INSUFFICIENT_STOCK"?"Магнитов уже недостаточно — обновите выбор.":"Не удалось записать сессию.")}})}
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
  toggleExternalConfirmation(booking: ExternalBooking) {
    this.confirmingId.set(booking.id);
    this.http.patch<{confirmed:boolean}>(`/api/time-to-grow/bookings/${booking.id}/confirmation`, { clubId: this.externalClubId, confirmed: !booking.confirmed }).subscribe({
      next: ({confirmed}) => { this.externalBookings.update(items=>items.map(item=>item.id===booking.id?{...item,confirmed}:item)); this.confirmingId.set(null); },
      error: () => { this.confirmingId.set(null); this.externalError.set("Не удалось изменить подтверждение брони."); },
    });
  }
  toggleConfirmation(booking: Booking) {
    this.confirmingId.set(booking.id);
    this.http.patch<{confirmed:boolean}>(`/api/bookings/${booking.id}/confirmation`, { confirmed: !booking.confirmed }).subscribe({
      next: ({confirmed}) => { this.bookings.update(items=>items.map(item=>item.id===booking.id?{...item,confirmed}:item)); this.confirmingId.set(null); },
      error: () => { this.confirmingId.set(null); this.error.set("Не удалось изменить подтверждение брони."); },
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
