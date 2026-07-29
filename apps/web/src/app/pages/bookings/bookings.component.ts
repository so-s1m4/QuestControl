import { Component, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";

type Room={id:string;name:string};
type Booking={id:string;room_id:string;room_name:string;customer_name:string;customer_phone:string|null;starts_at:string;ends_at:string;players:number;amount_cents:number;currency:string;payment_status:string;session_id:string|null;session_status:string|null};
type CheckedInPlayer={id:string;name:string;email:string|null;phone:string|null;birthday:string|null;waiverAccepted:boolean};
type ExternalBooking={id:string;date:string;startsAt:string;endsAt:string;status:string;statusDisplay:string;customerName:string;customerPhone:string|null;customerEmail:string|null;productName:string;players:number;amountCents:number;currency:string;paymentStatus:string;paymentStatusDisplay:string;checkedIn:number;checkInTotal:number;checkedInPlayers:CheckedInPlayer[]};
type ExternalClub={id:string;name:string;timezone:string;address:string|null};

@Component({
  selector:"app-bookings",standalone:true,imports:[FormsModule,RouterLink,DatePipe],
  template:`
  <main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a class="active" routerLink="/bookings">Бронирования</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/krampus">Krampus House</a><a routerLink="/users">Пользователи</a></nav></aside>
  <section><header><div><h2>Бронирования</h2><p>Расписание гостей и запуск игровых сессий</p></div><button (click)="showForm.set(!showForm())">{{showForm()?"Закрыть":"+ Новое бронирование"}}</button></header>
  <div class="external-toolbar"><div><h3>Time to Grow</h3><span>Подтверждённые бронирования</span></div><div class="external-filters"><label>Клуб<select [(ngModel)]="externalClubId" (ngModelChange)="loadExternal()">@for(club of externalClubs();track club.id){<option [value]="club.id">{{club.name}}</option>}</select></label><label>Дата<input type="date" [(ngModel)]="externalDate" (ngModelChange)="loadExternal()"></label></div></div>
  @if(externalLoading()){<p class="muted">Загружаем расписание…</p>}
  @if(externalError()){<p class="error">{{externalError()}}</p>}
  <div class="schedule external">@for(b of externalBookings();track b.id){<article [class.open]="expandedExternalId()===b.id">
    <div class="date"><b>{{b.startsAt}}</b><span>{{b.endsAt}}</span></div>
    <div class="booking-main"><strong>{{b.customerName}}</strong><span>{{b.productName}} · {{b.players}} игроков · {{b.amountCents/100}} {{b.currency}}</span><small>{{b.customerPhone || b.customerEmail || "Контакты не указаны"}}</small></div>
    <span class="pill" [class.paid]="b.paymentStatus==='paid'">{{b.paymentStatusDisplay}}</span>
    <button class="details-button" (click)="toggleExternal(b.id)">{{expandedExternalId()===b.id?"Скрыть":"Подробнее"}}</button>
    @if(expandedExternalId()===b.id){<div class="booking-details">
      <section><h4>Контакты бронирования</h4><dl><div><dt>Имя</dt><dd>{{b.customerName}}</dd></div><div><dt>Телефон</dt><dd>{{b.customerPhone || "—"}}</dd></div><div><dt>Email</dt><dd>{{b.customerEmail || "—"}}</dd></div><div><dt>Оплата</dt><dd>{{b.paymentStatusDisplay}} · {{b.amountCents/100}} {{b.currency}}</dd></div></dl></section>
      <section><h4>Прошли check-in <span class="pill checkin">{{b.checkedIn}}/{{b.checkInTotal}}</span></h4><div class="players">@for(player of b.checkedInPlayers;track player.id){<div class="player"><strong>{{player.name}}</strong><span>{{player.phone || player.email || "Контакты не указаны"}}</span><small>@if(player.birthday){Дата рождения: {{player.birthday}} · }Waiver: {{player.waiverAccepted?"принят":"не принят"}}</small></div>}@empty{<p class="muted">Персональные данные check-in пока отсутствуют.</p>}</div></section>
    </div>}
  </article>}@empty{ @if(!externalLoading()&&!externalError()){<div class="empty"><b>На эту дату бронирований нет</b><span>Выберите другую дату.</span></div>} }</div>
  @if(showForm()){<form (ngSubmit)="create()">
    <label>Гость<input name="customer" [(ngModel)]="draft.customerName" required minlength="2"></label>
    <label>Телефон<input name="phone" [(ngModel)]="draft.customerPhone"></label>
    <label>Комната<select name="room" [(ngModel)]="draft.roomId" required><option value="">Выберите</option>@for(r of rooms();track r.id){<option [value]="r.id">{{r.name}}</option>}</select></label>
    <label>Начало<input name="starts" type="datetime-local" [(ngModel)]="draft.startsAt" required></label>
    <label>Окончание<input name="ends" type="datetime-local" [(ngModel)]="draft.endsAt" required></label>
    <label>Игроков<input name="players" type="number" min="1" [(ngModel)]="draft.players"></label>
    <label>Сумма €<input name="amount" type="number" min="0" step=".01" [(ngModel)]="draft.amount"></label>
    <button [disabled]="saving()">{{saving()?"Сохраняем…":"Сохранить"}}</button>
  </form>}
  @if(error()){<p class="error">{{error()}}</p>}
  <div class="schedule">@for(b of bookings();track b.id){<article>
    <div class="date"><b>{{b.starts_at|date:'HH:mm'}}</b><span>{{b.starts_at|date:'dd MMM'}}</span></div>
    <div class="booking-main"><strong>{{b.customer_name}}</strong><span>{{b.room_name}} · {{b.players}} игроков · {{b.amount_cents/100}} {{b.currency}}</span></div>
    <span class="pill">{{b.payment_status}}</span>
    @if(b.session_id){<div class="session-actions"><span class="pill live">{{b.session_status}}</span>@if(b.session_status==="RUNNING"){<button class="ghost" (click)="session(b,'PAUSE')">Пауза</button>}@if(b.session_status==="PAUSED"){<button class="ghost" (click)="session(b,'RESUME')">Продолжить</button>}@if(b.session_status!=="FINISHED"){<button class="danger" (click)="session(b,'FINISH')">Завершить</button>}</div>}
    @else{<button (click)="start(b)">▶ Начать игру</button>}
  </article>}@empty{<div class="empty"><b>Бронирований пока нет</b><span>Создайте первое бронирование кнопкой выше.</span></div>}</div>
  </section></main>`,
  styles:[`.external-toolbar{display:flex;justify-content:space-between;align-items:end;margin-top:24px}.external-toolbar h3{margin:0}.external-toolbar span,.muted{color:var(--muted)}.external-filters{display:flex;gap:10px;align-items:end}.external-toolbar label{max-width:220px}.schedule{display:grid;gap:10px;margin-top:24px}.schedule.external{margin-top:12px;margin-bottom:28px}.schedule article{display:grid;grid-template-columns:80px 1fr auto auto;gap:16px;align-items:center;padding:16px 18px;background:#fff;border:1px solid var(--line);border-radius:14px}.schedule article.open{border-color:#b9c5ee;box-shadow:0 8px 28px rgba(52,72,165,.08)}.date b,.date span,.booking-main strong,.booking-main span,.booking-main small{display:block}.date b{font-size:20px}.date span,.booking-main span,.booking-main small{margin-top:4px;color:var(--muted)}.pill{padding:7px 10px;border-radius:999px;background:#f2f4f7;font-size:11px;font-weight:700}.pill.live,.pill.paid{background:#e8f8ef;color:#087443}.pill.checkin{background:#eef4ff;color:#3448a5}.details-button{background:#eef1f6;color:#344054;box-shadow:none}.booking-details{grid-column:1/-1;display:grid;grid-template-columns:minmax(240px,.8fr) minmax(320px,1.2fr);gap:24px;padding-top:18px;border-top:1px solid var(--line)}.booking-details section{min-width:0}.booking-details h4{margin:0 0 12px}.booking-details h4 .pill{margin-left:8px}.booking-details dl{display:grid;gap:9px;margin:0}.booking-details dl div{display:grid;grid-template-columns:85px 1fr;gap:10px}.booking-details dt{color:var(--muted)}.booking-details dd{margin:0;overflow-wrap:anywhere}.players{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.player{padding:11px 12px;border-radius:10px;background:#f7f8fb}.player strong,.player span,.player small{display:block}.player span,.player small{margin-top:3px;color:var(--muted);overflow-wrap:anywhere}.session-actions{display:flex;align-items:center;gap:7px}.ghost{padding:8px;background:#eef1f6;color:#344054;box-shadow:none}@media(max-width:900px){.external-toolbar,.external-filters{align-items:stretch;flex-direction:column;gap:12px}.schedule article{grid-template-columns:64px 1fr}.schedule>article>button,.schedule>article>.pill,.session-actions{grid-column:2;justify-self:start}.booking-details{grid-column:1/-1;grid-template-columns:1fr}.players{grid-template-columns:1fr}}`]
})
export class BookingsComponent{
  private http=inject(HttpClient);rooms=signal<Room[]>([]);bookings=signal<Booking[]>([]);showForm=signal(false);saving=signal(false);error=signal("");
  externalClubs=signal<ExternalClub[]>([]);externalClubId="";externalBookings=signal<ExternalBooking[]>([]);externalLoading=signal(false);externalError=signal("");expandedExternalId=signal<string|null>(null);externalDate=this.localDate(new Date());
  draft={customerName:"",customerPhone:"",roomId:"",startsAt:"",endsAt:"",players:2,amount:0};
  constructor(){this.load();this.loadExternalClubs();this.http.get<Room[]>("/api/rooms").subscribe({next:r=>this.rooms.set(r)});}
  private localDate(date:Date){const offset=date.getTimezoneOffset()*60_000;return new Date(date.getTime()-offset).toISOString().slice(0,10);}
  load(){this.http.get<Booking[]>("/api/bookings").subscribe({next:b=>this.bookings.set(b),error:()=>this.error.set("Не удалось загрузить бронирования.")});}
  loadExternalClubs(){this.externalLoading.set(true);this.http.get<{data:ExternalClub[];defaultClubId:string|null}>("/api/time-to-grow/clubs").subscribe({next:r=>{this.externalClubs.set(r.data);this.externalClubId=r.defaultClubId||"";this.loadExternal();},error:({status})=>{this.externalLoading.set(false);this.externalError.set(status===503?"Интеграция Time to Grow ещё не настроена.":"Не удалось загрузить клубы Time to Grow.");}});}
  loadExternal(){if(!this.externalDate||!this.externalClubId)return;this.expandedExternalId.set(null);this.externalLoading.set(true);this.externalError.set("");this.http.get<{data:ExternalBooking[]}>(`/api/time-to-grow/bookings?date=${encodeURIComponent(this.externalDate)}&clubId=${encodeURIComponent(this.externalClubId)}`).subscribe({next:r=>{this.externalBookings.set(r.data);this.externalLoading.set(false);},error:({status})=>{this.externalBookings.set([]);this.externalLoading.set(false);this.externalError.set(status===503?"Интеграция Time to Grow ещё не настроена.":"Не удалось загрузить бронирования Time to Grow.");}});}
  toggleExternal(id:string){this.expandedExternalId.update(current=>current===id?null:id);}
  create(){this.saving.set(true);this.error.set("");this.http.post("/api/bookings",{...this.draft,startsAt:new Date(this.draft.startsAt).toISOString(),endsAt:new Date(this.draft.endsAt).toISOString(),amountCents:Math.round(this.draft.amount*100),notes:""}).subscribe({next:()=>{this.saving.set(false);this.showForm.set(false);this.draft={customerName:"",customerPhone:"",roomId:"",startsAt:"",endsAt:"",players:2,amount:0};this.load();},error:({status})=>{this.saving.set(false);this.error.set(status===409?"Это время уже занято.":"Не удалось создать бронирование.");}});}
  start(b:Booking){this.http.post("/api/sessions",{bookingId:b.id,durationSeconds:3600}).subscribe({next:()=>this.load(),error:()=>this.error.set("Не удалось запустить игровую сессию.")});}
  session(b:Booking,action:"PAUSE"|"RESUME"|"FINISH"){this.http.patch(`/api/sessions/${b.session_id}`,{action}).subscribe({next:()=>this.load(),error:()=>this.error.set("Не удалось изменить состояние сессии.")});}
}
