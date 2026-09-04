import { Component, inject, signal } from "@angular/core";
import { DatePipe } from "@angular/common";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";
import { forkJoin } from "rxjs";

type User={id:string;display_name:string;is_active:boolean};
type Location={id:string;name:string};
type Shift={id:string;user_id:string;user_name:string;location_id:string;location_name:string;starts_at:string;ends_at:string;responsibility:string};

@Component({selector:"app-work-schedules",standalone:true,imports:[FormsModule,RouterLink,DatePipe],template:`
<main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="active" routerLink="/work-schedules">Графики работы</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/inventory">Инвентарь</a><a routerLink="/users">Пользователи</a></nav></aside>
<section><header><div><h2>Графики работы</h2><p>Кто, когда и за что отвечает на каждой локации</p></div><div class="week-nav"><button (click)="moveWeek(-7)">←</button><b>{{weekLabel()}}</b><button (click)="moveWeek(7)">→</button></div></header>
<form (ngSubmit)="addShift()"><label>Сотрудник<select name="user" [(ngModel)]="userId" required><option value="">Выберите</option>@for(u of users();track u.id){<option [value]="u.id">{{u.display_name}}</option>}</select></label><label>Локация<select name="location" [(ngModel)]="locationId" required><option value="">Выберите</option>@for(l of locations();track l.id){<option [value]="l.id">{{l.name}}</option>}</select></label><label>Начало<input name="start" type="datetime-local" [(ngModel)]="startsAt" required></label><label>Конец<input name="end" type="datetime-local" [(ngModel)]="endsAt" required></label><label>Ответственность<input name="responsibility" [(ngModel)]="responsibility" placeholder="Ресепшен, VR-зона…" required></label><button [disabled]="saving()">{{saving()?"Сохраняем…":"Добавить смену"}}</button></form>
@if(error()){<p class="error">{{error()}}</p>}
<div class="week-grid">@for(day of days();track day.key){<section class="day" [class.today]="day.today"><header><b>{{dayTitle(day.date)}}</b><span>{{dayDate(day.date)}}</span></header><div class="shifts">@for(s of shiftsFor(day.key);track s.id){<article><div><b>{{s.user_name}}</b><span>{{s.starts_at|date:'HH:mm'}}–{{s.ends_at|date:'HH:mm'}} · {{s.location_name}}</span><strong>{{s.responsibility}}</strong></div><button aria-label="Удалить смену" (click)="remove(s)">×</button></article>}@empty{<p>Смен нет</p>}</div></section>}</div>
</section></main>`,styles:[`
.week-nav{display:flex;align-items:center;gap:12px}.week-nav button{padding:8px 12px}.week-nav b{min-width:170px;text-align:center}form{grid-template-columns:1fr 1fr 1fr 1fr 1.5fr auto!important}.week-grid{display:grid;grid-template-columns:repeat(7,minmax(155px,1fr));gap:10px;margin-top:24px;overflow-x:auto}.day{min-height:360px;border:1px solid var(--line);border-radius:14px;background:#fff}.day.today{border-color:#7c83ff;box-shadow:0 0 0 2px #7c83ff22}.day>header{display:flex;justify-content:space-between;padding:13px;border-bottom:1px solid var(--line);text-transform:capitalize}.day>header span{color:var(--muted)}.shifts{display:grid;gap:8px;padding:9px}.shifts article{display:flex;align-items:start;gap:5px;padding:11px;border-radius:10px;background:#f3f4ff;border-left:3px solid var(--primary)}.shifts article div{min-width:0;flex:1}.shifts b,.shifts span,.shifts strong{display:block}.shifts span{margin:4px 0;color:var(--muted);font-size:10px}.shifts strong{overflow-wrap:anywhere;font-size:11px}.shifts button{padding:2px 6px;background:transparent;box-shadow:none;color:#98a2b3;font-size:18px}.shifts>p{color:var(--muted);font-size:11px;text-align:center}.error{color:var(--danger)}@media(max-width:1100px){form{grid-template-columns:repeat(2,minmax(0,1fr))!important}form button{grid-column:1/-1}.week-grid{grid-template-columns:repeat(7,180px)}}@media(max-width:760px){main>section>header{display:grid!important}.week-nav{justify-content:space-between}form{grid-template-columns:1fr!important}.week-grid{margin-bottom:85px}}
`]})
export class WorkSchedulesComponent{
 private http=inject(HttpClient); users=signal<User[]>([]);locations=signal<Location[]>([]);shifts=signal<Shift[]>([]);saving=signal(false);error=signal("");weekStart=signal(this.monday(new Date()));userId="";locationId="";startsAt="";endsAt="";responsibility="";
 constructor(){forkJoin({users:this.http.get<User[]>("/api/users"),locations:this.http.get<Location[]>("/api/locations")}).subscribe({next:r=>{this.users.set(r.users.filter(u=>u.is_active));this.locations.set(r.locations);this.locationId=r.locations[0]?.id||"";this.load()},error:()=>this.error.set("Не удалось загрузить сотрудников и локации.")});}
 monday(value:Date){const d=new Date(value);d.setHours(0,0,0,0);d.setDate(d.getDate()-((d.getDay()+6)%7));return d;}
 localDate(d:Date){const copy=new Date(d.getTime()-d.getTimezoneOffset()*60000);return copy.toISOString().slice(0,10)}
 days(){return Array.from({length:7},(_,i)=>{const date=new Date(this.weekStart());date.setDate(date.getDate()+i);return{date,key:this.localDate(date),today:this.localDate(date)===this.localDate(new Date())}})}
 weekLabel(){const d=this.days();return `${d[0].date.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})} — ${d[6].date.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})}`}
 dayTitle(date:Date){return date.toLocaleDateString("ru-RU",{weekday:"short"})}
 dayDate(date:Date){return date.toLocaleDateString("ru-RU",{day:"numeric",month:"short"})}
 moveWeek(days:number){const d=new Date(this.weekStart());d.setDate(d.getDate()+days);this.weekStart.set(d);this.load()}
 load(){const ds=this.days();this.http.get<Shift[]>(`/api/work-schedules?from=${ds[0].key}&to=${ds[6].key}`).subscribe({next:s=>this.shifts.set(s),error:()=>this.error.set("Не удалось загрузить график.")})}
 shiftsFor(day:string){return this.shifts().filter(s=>this.localDate(new Date(s.starts_at))===day)}
 addShift(){if(!this.userId||!this.locationId||!this.startsAt||!this.endsAt||!this.responsibility.trim())return;this.saving.set(true);this.error.set("");this.http.post("/api/work-schedules",{userId:this.userId,locationId:this.locationId,startsAt:new Date(this.startsAt).toISOString(),endsAt:new Date(this.endsAt).toISOString(),responsibility:this.responsibility.trim()}).subscribe({next:()=>{this.saving.set(false);this.responsibility="";this.load()},error:({status})=>{this.saving.set(false);this.error.set(status===409?"У сотрудника уже есть смена в это время.":"Не удалось добавить смену.")}})}
 remove(s:Shift){this.http.delete(`/api/work-schedules/${s.id}`).subscribe({next:()=>this.shifts.update(items=>items.filter(i=>i.id!==s.id)),error:()=>this.error.set("Не удалось удалить смену.")})}
}
