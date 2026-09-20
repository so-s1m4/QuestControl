import { Component, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { AsyncPipe, DatePipe } from "@angular/common";
import { RouterLink } from "@angular/router";

type DashboardDay={day:string;bookings:number};
type DashboardData={
  rooms:any[];
  bookings:any[];
  deviceSummary:{status:string;total:number}[];
  myShifts:any[];
  statistics:{bookings_30d:number;customers_30d:number;revenue_cents_30d:number;upcoming_7d:number;sessions_30d:number};
  recentDays:DashboardDay[];
};

@Component({selector:"app-overview",standalone:true,imports:[AsyncPipe,DatePipe,RouterLink],template:`
<main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a class="active" routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="sessions-nav" routerLink="/sessions">Сессии</a><a class="sessions-nav" routerLink="/work-schedules">Графики работы</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/inventory">Инвентарь</a><a routerLink="/users">Пользователи</a><a routerLink="/telegram">Telegram</a><a class="reception-nav" routerLink="/reception/checkin">↗ Check-in гостей</a></nav></aside>
<section><header><div><h2>Центр управления</h2><p>{{fullDate(today)}}</p></div><button routerLink="/work-schedules" [queryParams]="{time:'1'}">◷ Записать время</button></header>
@if(data$|async;as data){
  <a class="my-shift" [class.has-shift]="data.myShifts.length" routerLink="/work-schedules"><span class="shift-icon">{{data.myShifts.length?'✓':'—'}}</span><div><small>Моя смена сегодня</small>@if(data.myShifts.length){@for(shift of data.myShifts;track shift.id){<strong>{{shift.starts_at|date:'HH:mm'}}–{{shift.ends_at|date:'HH:mm'}} · {{locationLabel(shift.location_name)}}</strong><p>{{shift.responsibility}}</p>}}@else{<strong>Сегодня смены нет</strong><p>Можно спокойно планировать день.</p>}</div><b>Открыть →</b></a>

  <div class="stats-grid">
    <article class="accent"><span>Сегодня</span><b>{{data.bookings.length}}</b><small>бронирований</small></article>
    <article><span>Последние 30 дней</span><b>{{data.statistics.bookings_30d}}</b><small>бронирований</small></article>
    <article><span>Клиенты за 30 дней</span><b>{{data.statistics.customers_30d}}</b><small>забронированных мест</small></article>
    <article><span>Оборот за 30 дней</span><b>{{formatCurrency(data.statistics.revenue_cents_30d)}}</b><small>по сохранённым броням</small></article>
    <article><span>Следующие 7 дней</span><b>{{data.statistics.upcoming_7d}}</b><small>предстоящих броней</small></article>
    <article><span>Сессии за 30 дней</span><b>{{data.statistics.sessions_30d}}</b><small>запущенных игр</small></article>
  </div>

  <div class="dashboard-grid">
    <article class="panel activity-panel"><div class="panel-title"><div><small>АКТИВНОСТЬ</small><h3>Брони за 7 дней</h3></div><strong>{{recentTotal(data.recentDays)}}</strong></div><div class="chart">@for(day of data.recentDays;track day.day){<div class="bar-column"><span>{{day.bookings}}</span><i [style.height.%]="barHeight(day.bookings,data.recentDays)"></i><small>{{dayLabel(day.day)}}</small></div>}</div></article>
    <article class="panel system-panel"><div class="panel-title"><div><small>СИСТЕМА</small><h3>Состояние площадок</h3></div></div><div class="system-list"><div><span class="system-icon rooms"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v17M2 21h20"/><path d="M8 6h4M8 10h4M8 14h4M16 17h.01"/></svg></span><p><b>{{data.rooms.length}}</b><small>комнат всего</small></p></div><div><span class="system-icon online"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 12.5 10.5 15 16.5 9"/></svg></span><p><b>{{deviceCount(data,'ONLINE')}}</b><small>устройств онлайн</small></p></div><div><span class="system-icon offline"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 9 6 6m0-6-6 6"/></svg></span><p><b>{{deviceCount(data,'OFFLINE')}}</b><small>устройств офлайн</small></p></div></div></article>
  </div>

  <article class="panel today-panel"><div class="panel-title"><div><small>СЕГОДНЯ</small><h3>Ближайшие бронирования</h3></div><a routerLink="/bookings">Все брони →</a></div><div class="booking-list">@for(booking of data.bookings.slice(0,6);track booking.id){<div><time>{{booking.starts_at|date:'HH:mm'}}</time><p><b>{{booking.customer_name}}</b><small>{{booking.room_name}} · {{booking.players}} гостей</small></p><span [class.confirmed]="booking.confirmed">{{booking.confirmed?'Подтверждено':'Ожидает'}}</span></div>}@empty{<div class="empty">На сегодня бронирований нет.</div>}</div></article>
}@else{<p class="loading">Загрузка центра управления…</p>}
</section></main>`,styles:[`
.reception-nav{margin-top:10px!important;border:1px solid #ff672755;color:#fff!important}.my-shift{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:14px;margin-top:14px;padding:15px 18px;border:1px solid #e1e5ec;border-radius:13px;background:#fff;color:#344054;text-decoration:none}.my-shift.has-shift{border-color:#a6dfbf;background:linear-gradient(110deg,#f2fbf6,#fff)}.shift-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:11px;background:#eef1f6;color:#788295;font-weight:900}.has-shift .shift-icon{background:#d8f3e4;color:#087443}.my-shift small,.my-shift strong,.my-shift p{display:block}.my-shift small{color:#788295;font-size:9px;font-weight:800;text-transform:uppercase}.my-shift strong{margin-top:3px}.my-shift p{margin:2px 0 0;color:#667085;font-size:10px}.my-shift>b{color:#4f46e5;font-size:10px}
.stats-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin-top:14px}.stats-grid article{min-width:0;padding:16px;border:1px solid #e1e5ec;border-radius:14px;background:#fff;box-shadow:0 5px 18px #18213a08}.stats-grid article.accent{border-color:#cbd0ff;background:linear-gradient(145deg,#f0f1ff,#fff)}.stats-grid span,.stats-grid small,.stats-grid b{display:block}.stats-grid span{min-height:24px;color:#667085;font-size:9px;font-weight:800;text-transform:uppercase}.stats-grid b{margin:7px 0 3px;color:#172033;font-size:clamp(20px,2.2vw,30px);line-height:1}.stats-grid small{overflow:hidden;color:#98a2b3;font-size:9px;text-overflow:ellipsis;white-space:nowrap}
.dashboard-grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(250px,.7fr);gap:12px;margin-top:12px}.panel{border:1px solid #e1e5ec;border-radius:15px;background:#fff;box-shadow:0 8px 25px #18213a08}.panel-title{display:flex;align-items:center;justify-content:space-between;padding:13px 17px;border-bottom:1px solid #edf0f4}.panel-title small{color:#7c87a0;font-size:8px;font-weight:900;letter-spacing:.12em}.panel-title h3{margin:3px 0 0;color:#20283d;font-size:15px}.panel-title>strong{color:#4f46e5;font-size:23px}.panel-title>a{color:#4f46e5;font-size:10px;font-weight:800;text-decoration:none}.chart{display:flex;align-items:flex-end;gap:clamp(8px,2vw,22px);height:132px;padding:17px 22px 13px}.bar-column{display:grid;grid-template-rows:16px minmax(8px,1fr) 16px;align-items:end;justify-items:center;height:100%;flex:1}.bar-column>span{color:#667085;font-size:9px;font-weight:800}.bar-column>i{width:min(32px,70%);min-height:6px;border-radius:7px 7px 3px 3px;background:linear-gradient(180deg,#7c83ef,#4f56d9);box-shadow:0 5px 12px #525bd52b}.bar-column>small{align-self:end;color:#98a2b3;font-size:9px;text-transform:capitalize}.system-list{display:grid;gap:0;padding:5px 16px 8px}.system-list>div{display:flex;align-items:center;gap:10px;padding:7px 2px;border-bottom:1px solid #f0f2f5}.system-list>div:last-child{border:0}.system-icon{display:grid;width:30px;height:30px;place-items:center;border-radius:9px;background:#eef0ff;color:#5962db}.system-icon svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.system-icon.online{background:#e4f8ed;color:#15a467}.system-icon.offline{background:#fff0f0;color:#d64b4b}.system-list p{margin:0}.system-list b,.system-list small{display:block}.system-list b{font-size:15px}.system-list small{margin-top:1px;color:#8b95a7;font-size:8px}.today-panel{margin-top:12px}.booking-list{display:grid}.booking-list>div:not(.empty){display:grid;grid-template-columns:64px 1fr auto;align-items:center;gap:12px;padding:11px 18px;border-bottom:1px solid #edf0f4}.booking-list>div:last-child{border:0}.booking-list time{color:#4f46e5;font-weight:900}.booking-list p{margin:0}.booking-list p b,.booking-list p small{display:block}.booking-list p small{margin-top:3px;color:#7c8798;font-size:9px}.booking-list>div>span{padding:5px 8px;border-radius:7px;background:#fff5df;color:#a66800;font-size:8px;font-weight:900}.booking-list>div>span.confirmed{background:#e4f8ed;color:#087443}.empty,.loading{padding:30px;color:#8a94a6;text-align:center}
@media(max-width:1180px){.stats-grid{grid-template-columns:repeat(3,1fr)}}@media(max-width:760px){.stats-grid{grid-template-columns:repeat(2,1fr)}.dashboard-grid{grid-template-columns:1fr}.my-shift{grid-template-columns:auto 1fr}.my-shift>b{grid-column:1/-1;text-align:center}.booking-list>div:not(.empty){grid-template-columns:50px 1fr}.booking-list>div>span{grid-column:2;justify-self:start}.chart{gap:8px;padding-inline:12px}.bar-column>i{width:70%}}@media(max-width:420px){.stats-grid{grid-template-columns:1fr 1fr}.stats-grid article{padding:13px}.stats-grid b{font-size:21px}}
`]})
export class OverviewComponent{
  private http=inject(HttpClient);
  today=new Date();
  data$=this.http.get<DashboardData>("/api/dashboard");
  locationLabel(name:string){return name?.replace(/_/g," ")||"Локация"}
  formatCurrency(cents:number){return new Intl.NumberFormat("de-AT",{style:"currency",currency:"EUR",maximumFractionDigits:0}).format(Number(cents||0)/100)}
  recentTotal(days:DashboardDay[]){return days.reduce((sum,day)=>sum+Number(day.bookings||0),0)}
  barHeight(value:number,days:DashboardDay[]){const max=Math.max(1,...days.map(day=>Number(day.bookings||0)));return Math.max(6,Math.round(Number(value||0)/max*100))}
  deviceCount(data:DashboardData,status:string){return Number(data.deviceSummary.find(item=>item.status===status)?.total||0)}
  fullDate(value:Date){return new Intl.DateTimeFormat("ru-RU",{weekday:"long",year:"numeric",month:"long",day:"numeric"}).format(value)}
  dayLabel(value:string){return new Intl.DateTimeFormat("ru-RU",{weekday:"short"}).format(new Date(`${value}T12:00:00`)).replace(".","")}
}
