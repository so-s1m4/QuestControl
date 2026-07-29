import { Component, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";

type Location={
  id:string;
  name:string;
  timezone:string;
  address:string|null;
  phone:string|null;
  email:string|null;
};

@Component({
  selector:"app-locations",
  standalone:true,
  imports:[RouterLink],
  template:`
  <main>
    <aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="active" routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/krampus">Krampus House</a><a routerLink="/users">Пользователи</a></nav></aside>
    <section>
      <header><div><h2>Локации</h2><p>Площадки из Time to Grow</p></div><button class="secondary" (click)="load()" [disabled]="loading()">{{loading()?"Обновляем…":"↻ Обновить"}}</button></header>
      @if(error()){<p class="error">{{error()}}</p>}
      <div class="location-grid">
        @for(location of locations();track location.id){<article>
          <div class="location-head"><div><span class="eyebrow">TIME TO GROW</span><h3>{{location.name}}</h3></div><span class="timezone">{{location.timezone}}</span></div>
          <dl>
            <div><dt>Адрес</dt><dd>{{location.address||"Не указан"}}</dd></div>
            <div><dt>Телефон</dt><dd>@if(location.phone){<a [href]="'tel:'+location.phone">{{location.phone}}</a>}@else{—}</dd></div>
            <div><dt>Email</dt><dd>@if(location.email){<a [href]="'mailto:'+location.email">{{location.email}}</a>}@else{—}</dd></div>
          </dl>
          <a class="bookings-link" [routerLink]="['/bookings']">Открыть бронирования →</a>
        </article>}@empty{@if(!loading()&&!error()){<div class="empty"><b>Локаций пока нет</b><span>Time to Grow не вернул доступных площадок.</span></div>}}
      </div>
    </section>
  </main>`,
  styles:[`
    .secondary{background:#eef1f6;color:#344054;box-shadow:none}
    .location-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:24px}
    .location-grid article{padding:22px;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 24px #19213a08}
    .location-head{display:flex;justify-content:space-between;align-items:start;gap:16px}
    .location-head h3{margin:6px 0 20px;font-size:21px}.eyebrow{color:var(--primary);font-size:10px;font-weight:800;letter-spacing:1px}
    .timezone{padding:7px 9px;border-radius:999px;background:#eef4ff;color:#3448a5;font-size:10px;font-weight:800}
    dl{display:grid;gap:12px;margin:0}dl div{display:grid;grid-template-columns:75px 1fr;gap:12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}dd a{color:var(--ink);text-decoration:none}dd a:hover{color:var(--primary)}
    .bookings-link{display:block;margin-top:20px;color:var(--primary);text-decoration:none;font-weight:700}.empty{grid-column:1/-1}
    @media(max-width:900px){.location-grid{grid-template-columns:1fr}}
  `]
})
export class LocationsComponent{
  private http=inject(HttpClient);
  locations=signal<Location[]>([]);
  loading=signal(false);
  error=signal("");
  constructor(){this.load();}
  load(){this.loading.set(true);this.error.set("");this.http.get<{data:Location[]}>("/api/time-to-grow/clubs").subscribe({next:r=>{this.locations.set(r.data);this.loading.set(false);},error:()=>{this.locations.set([]);this.loading.set(false);this.error.set("Не удалось загрузить локации Time to Grow.");}});}
}
