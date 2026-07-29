import { DatePipe } from "@angular/common";
import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";
import { forkJoin } from "rxjs";

type Location={id:string;name:string};
type Session={
  id:string;status:string;started_at:string|null;ended_at:string|null;
  room_name:string;location_name:string;player_count:number;
  identified_player_count:number;anonymous_player_count:number;elapsed_seconds:number|null;
};
type Breakdown={player_plays:number;identified_unique_players:number;sessions?:number};
type Statistics={
  summary:{player_plays:number;identified_unique_players:number;anonymous_player_plays:number;cross_location_players:number;sessions:number};
  byCategory:(Breakdown&{category:string})[];
  byAgeBand:(Breakdown&{age_band:string})[];
  byGame:(Breakdown&{room_id:string;game:string})[];
  byLocation:(Breakdown&{location_id:string;location:string})[];
};

@Component({
  selector:"app-sessions",
  standalone:true,
  imports:[RouterLink,FormsModule,DatePipe],
  template:`
  <main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="active" routerLink="/sessions">Сессии</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/krampus">Krampus House</a><a routerLink="/users">Пользователи</a></nav></aside>
  <section>
    <header><div><h2>Сессии</h2><p>История игр и статистика по всей сети</p></div><button class="secondary" (click)="load()" [disabled]="loading()">{{loading()?"Обновляем…":"↻ Обновить"}}</button></header>
    <div class="filters">
      <label>Локация<select [(ngModel)]="locationId" (ngModelChange)="load()"><option value="">Все доступные локации</option>@for(location of locations();track location.id){<option [value]="location.id">{{location.name}}</option>}</select></label>
      <label>С<input type="date" [(ngModel)]="from" (change)="load()"></label>
      <label>По<input type="date" [(ngModel)]="to" (change)="load()"></label>
    </div>
    @if(error()){<p class="error">{{error()}}</p>}
    @if(stats();as data){
      <div class="metric-grid">
        <article><span>Сыграло</span><b>{{data.summary.player_plays}}</b><small>участий в играх</small></article>
        <article><span>Уникальных</span><b>{{data.summary.identified_unique_players}}</b><small>по защищённому идентификатору</small></article>
        <article><span>Без email</span><b>{{data.summary.anonymous_player_plays}}</b><small>учтены без повторной связи</small></article>
        <article><span>Между локациями</span><b>{{data.summary.cross_location_players}}</b><small>сыграли более чем на одной площадке</small></article>
        <article><span>Сессий</span><b>{{data.summary.sessions}}</b><small>за выбранный период</small></article>
      </div>
      <div class="breakdowns">
        <article><h3>По локациям</h3>@for(row of data.byLocation;track row.location_id){<div class="bar-row"><span>{{row.location}}</span><b>{{row.player_plays}}</b><small>{{row.sessions}} сесс.</small></div>}@empty{<p>Нет данных</p>}</article>
        <article><h3>По играм</h3>@for(row of data.byGame;track row.room_id){<div class="bar-row"><span>{{row.game}}</span><b>{{row.player_plays}}</b><small>{{row.identified_unique_players}} уник.</small></div>}@empty{<p>Нет данных</p>}</article>
        <article><h3>По категориям</h3>@for(row of data.byCategory;track row.category){<div class="bar-row"><span>{{category(row.category)}}</span><b>{{row.player_plays}}</b><small>{{row.identified_unique_players}} уник.</small></div>}@empty{<p>Нет данных</p>}</article>
      </div>
    }
    <div class="list-head"><h3>История сессий</h3><span>Последние 250 запусков</span></div>
    <div class="session-list">
      @for(item of sessions();track item.id){<article>
        <div class="when"><b>{{item.started_at?(item.started_at|date:'dd.MM.yyyy'):"—"}}</b><span>{{item.started_at?(item.started_at|date:'HH:mm'):"—"}}</span></div>
        <div class="place"><strong>{{item.room_name}}</strong><span>{{item.location_name}}</span></div>
        <div class="players"><b>{{item.player_count}}</b><span>игроков</span></div>
        <div class="duration"><b>{{duration(item.elapsed_seconds)}}</b><span>время</span></div>
        <span class="status" [class.running]="item.status==='RUNNING'" [class.finished]="item.status==='FINISHED'">{{status(item.status)}}</span>
      </article>}@empty{@if(!loading()){<div class="empty"><b>Сессий за этот период нет</b><span>Измените фильтр локации или даты.</span></div>}}
    </div>
  </section></main>`,
  styles:[`
    .secondary{background:#eef1f6;color:#344054;box-shadow:none}.filters{display:grid;grid-template-columns:minmax(240px,1fr) 180px 180px;gap:12px;margin:24px 0;padding:18px;background:#fff;border:1px solid var(--line);border-radius:14px}
    .metric-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:14px}.metric-grid article,.breakdowns article{padding:20px;background:#fff;border:1px solid var(--line);border-radius:15px;box-shadow:0 8px 24px #19213a08}.metric-grid span,.metric-grid small{display:block;color:var(--muted)}.metric-grid b{display:block;margin:8px 0 4px;font-size:30px}.metric-grid small{font-size:11px}
    .breakdowns{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;margin-top:14px}.breakdowns h3{margin:0 0 14px}.breakdowns p{color:var(--muted)}.bar-row{display:grid;grid-template-columns:minmax(0,1fr) auto 72px;gap:10px;padding:10px 0;border-top:1px solid #eef0f4}.bar-row span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bar-row small{color:var(--muted);text-align:right}
    .list-head{display:flex;justify-content:space-between;align-items:center;margin:28px 0 12px}.list-head h3{margin:0}.list-head span{color:var(--muted);font-size:12px}.session-list{display:grid;gap:9px}.session-list article{display:grid;grid-template-columns:110px minmax(220px,1fr) 100px 110px 110px;gap:16px;align-items:center;padding:16px 18px;background:#fff;border:1px solid var(--line);border-radius:13px}.when b,.when span,.place strong,.place span,.players b,.players span,.duration b,.duration span{display:block}.when span,.place span,.players span,.duration span{margin-top:4px;color:var(--muted);font-size:11px}.players b,.duration b{font-size:16px}.status{justify-self:end;padding:7px 10px;border-radius:999px;background:#f2f4f7;color:#475467;font-size:10px;font-weight:800}.status.running{background:#e8f8ef;color:#087443}.status.finished{background:#eef4ff;color:#3448a5}
    @media(max-width:1000px){.metric-grid{grid-template-columns:1fr 1fr}.breakdowns{grid-template-columns:1fr}.session-list article{grid-template-columns:90px 1fr 90px}.duration,.status{grid-column:auto}.status{justify-self:start}}
    @media(max-width:700px){.filters,.metric-grid{grid-template-columns:1fr}.session-list article{grid-template-columns:72px 1fr}.players,.duration,.status{grid-column:2}}
  `]
})
export class SessionsComponent{
  private http=inject(HttpClient);
  locations=signal<Location[]>([]);sessions=signal<Session[]>([]);stats=signal<Statistics|null>(null);
  loading=signal(false);error=signal("");locationId="";
  from=this.iso(new Date(Date.now()-30*86_400_000));to=this.iso(new Date());
  constructor(){this.http.get<Location[]>("/api/locations").subscribe({next:locations=>{this.locations.set(locations);this.load();},error:()=>this.error.set("Не удалось загрузить доступные локации.")});}
  load(){this.loading.set(true);this.error.set("");const query=new URLSearchParams({from:this.from,to:this.to});if(this.locationId)query.set("locationId",this.locationId);forkJoin({sessions:this.http.get<Session[]>(`/api/sessions?${query}`),stats:this.http.get<Statistics>(`/api/statistics/players?${query}`)}).subscribe({next:result=>{this.sessions.set(result.sessions);this.stats.set(result.stats);this.loading.set(false);},error:()=>{this.loading.set(false);this.error.set("Не удалось загрузить историю сессий.");}});}
  duration(seconds:number|null){if(seconds===null)return"—";const hours=Math.floor(seconds/3600);const minutes=Math.floor(seconds%3600/60);return hours?`${hours} ч ${minutes} мин`:`${minutes} мин`;}
  status(value:string){return({RUNNING:"Идёт",PAUSED:"Пауза",FINISHED:"Завершена",CANCELLED:"Отменена"} as Record<string,string>)[value]||value;}
  category(value:string){return value==="UNKNOWN"?"Не указана":value;}
  private iso(date:Date){return date.toISOString().slice(0,10);}
}
