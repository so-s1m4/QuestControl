import { Component, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";

type Room={id:string;name:string};
type Booking={id:string;room_id:string;room_name:string;customer_name:string;customer_phone:string|null;starts_at:string;ends_at:string;players:number;amount_cents:number;currency:string;payment_status:string;session_id:string|null;session_status:string|null};

@Component({
  selector:"app-bookings",standalone:true,imports:[FormsModule,RouterLink,DatePipe],
  template:`
  <main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a class="active" routerLink="/bookings">Бронирования</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/krampus">Krampus House</a><a routerLink="/users">Пользователи</a></nav></aside>
  <section><header><div><h2>Бронирования</h2><p>Расписание гостей и запуск игровых сессий</p></div><button (click)="showForm.set(!showForm())">{{showForm()?"Закрыть":"+ Новое бронирование"}}</button></header>
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
  styles:[`.schedule{display:grid;gap:10px;margin-top:24px}.schedule article{display:grid;grid-template-columns:80px 1fr auto auto;gap:16px;align-items:center;padding:16px 18px;background:#fff;border:1px solid var(--line);border-radius:14px}.date b,.date span,.booking-main strong,.booking-main span{display:block}.date b{font-size:20px}.date span,.booking-main span{margin-top:4px;color:var(--muted)}.pill{padding:7px 10px;border-radius:999px;background:#f2f4f7;font-size:11px;font-weight:700}.pill.live{background:#e8f8ef;color:#087443}.session-actions{display:flex;align-items:center;gap:7px}.ghost{padding:8px;background:#eef1f6;color:#344054;box-shadow:none}@media(max-width:900px){.schedule article{grid-template-columns:64px 1fr}.schedule button,.pill,.session-actions{grid-column:2;justify-self:start}}`]
})
export class BookingsComponent{
  private http=inject(HttpClient);rooms=signal<Room[]>([]);bookings=signal<Booking[]>([]);showForm=signal(false);saving=signal(false);error=signal("");
  draft={customerName:"",customerPhone:"",roomId:"",startsAt:"",endsAt:"",players:2,amount:0};
  constructor(){this.load();this.http.get<Room[]>("/api/rooms").subscribe({next:r=>this.rooms.set(r)});}
  load(){this.http.get<Booking[]>("/api/bookings").subscribe({next:b=>this.bookings.set(b),error:()=>this.error.set("Не удалось загрузить бронирования.")});}
  create(){this.saving.set(true);this.error.set("");this.http.post("/api/bookings",{...this.draft,startsAt:new Date(this.draft.startsAt).toISOString(),endsAt:new Date(this.draft.endsAt).toISOString(),amountCents:Math.round(this.draft.amount*100),notes:""}).subscribe({next:()=>{this.saving.set(false);this.showForm.set(false);this.draft={customerName:"",customerPhone:"",roomId:"",startsAt:"",endsAt:"",players:2,amount:0};this.load();},error:({status})=>{this.saving.set(false);this.error.set(status===409?"Это время уже занято.":"Не удалось создать бронирование.");}});}
  start(b:Booking){this.http.post("/api/sessions",{bookingId:b.id,durationSeconds:3600}).subscribe({next:()=>this.load(),error:()=>this.error.set("Не удалось запустить игровую сессию.")});}
  session(b:Booking,action:"PAUSE"|"RESUME"|"FINISH"){this.http.patch(`/api/sessions/${b.session_id}`,{action}).subscribe({next:()=>this.load(),error:()=>this.error.set("Не удалось изменить состояние сессии.")});}
}
