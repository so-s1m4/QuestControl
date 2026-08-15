import { Component, OnDestroy, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";

type EndpointStatus={online:boolean;latencyMs:number|null;status:number|null};
type VrStatus={location:{id:string;name:string};panel:EndpointStatus;device:EndpointStatus;ready:boolean};

@Component({
  selector:"app-vr-poelten",
  standalone:true,
  imports:[RouterLink],
  template:`
  <main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="sessions-nav" routerLink="/sessions">Сессии</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/inventory">Инвентарь</a><a routerLink="/users">Пользователи</a></nav></aside>
  <section>
    <header><div><h2>VR Санкт-Пёльтен</h2><p>Запуск и управление VR через защищённое соединение Quest Control</p></div><button class="secondary" (click)="load()" [disabled]="loading()">{{loading()?"Проверяем…":"↻ Проверить"}}</button></header>
    @if(error()){<p class="error">{{error()}}</p>}
    <div class="status-grid">
      <article><div class="icon">PC</div><div><span>Windows VRP</span><b>{{status()?.panel?.online?"Подключён":"Не подключён"}}</b><small>{{latency(status()?.panel)}}</small></div><i [class.online]="status()?.panel?.online"></i></article>
      <article><div class="icon">VR</div><div><span>ARVI Server</span><b>{{status()?.device?.online?"Доступен":"Недоступен"}}</b><small>{{latency(status()?.device)}}</small></div><i [class.online]="status()?.device?.online"></i></article>
    </div>
    <article class="launch-card" [class.ready]="status()?.ready">
      <div><span class="eyebrow">{{status()?.location?.name||"Sankt Pölten"}}</span><h3>Панель запуска VR</h3><p>Откроется в отдельной вкладке. Доступ выдаётся только на текущую авторизованную сессию Quest Control.</p></div>
      <button class="launch" (click)="launch()" [disabled]="!status()?.ready||launching()">{{launching()?"Открываем…":"Запустить VR-панель →"}}</button>
    </article>
    @if(status()&&!status()?.ready){<div class="notice"><b>Панель пока не готова</b><span>@if(!status()?.panel?.online){Windows-туннель не подключён. }@if(!status()?.device?.online){Нужен закрытый туннель к ARVI Server на порту 6101.}</span></div>}
  </section></main>`,
  styles:[`
    .secondary{background:#eef1f6;color:#344054;box-shadow:none}.status-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:28px 0}.status-grid article{position:relative;display:flex;align-items:center;gap:15px;padding:20px;background:#fff;border:1px solid var(--line);border-radius:15px;box-shadow:0 8px 24px #19213a08}.icon{display:grid;place-items:center;width:48px;height:48px;border-radius:13px;background:#eef0ff;color:#434bc4;font-weight:800}.status-grid span,.status-grid small{display:block;color:var(--muted)}.status-grid b{display:block;margin:4px 0;font-size:17px}.status-grid i{position:absolute;right:20px;width:12px;height:12px;border-radius:50%;background:#d92d45;box-shadow:0 0 0 5px #d92d4512}.status-grid i.online{background:#12a05c;box-shadow:0 0 0 5px #12a05c18}.launch-card{display:flex;align-items:center;justify-content:space-between;gap:30px;padding:30px;background:linear-gradient(135deg,#1b2438,#273450);color:#fff;border-radius:18px;box-shadow:0 18px 42px #17203324}.launch-card.ready{background:linear-gradient(135deg,#25266d,#4d4fc4)}.launch-card h3{margin:6px 0 8px;font-size:25px}.launch-card p{max-width:680px;margin:0;color:#cbd3e4;line-height:1.6}.eyebrow{color:#aeb8ff;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px}.launch{white-space:nowrap;background:#fff;color:#3437a6;box-shadow:none;padding:14px 20px}.notice{display:grid;gap:7px;margin-top:16px;padding:18px;border:1px solid #f0d29d;border-radius:13px;background:#fff9eb}.notice span{color:#785b22}@media(max-width:800px){.status-grid{grid-template-columns:1fr}.launch-card{align-items:flex-start;flex-direction:column}.launch{width:100%}}
  `]
})
export class VrPoeltenComponent implements OnDestroy{
  private http=inject(HttpClient);private timer?:ReturnType<typeof setInterval>;
  status=signal<VrStatus|null>(null);loading=signal(false);launching=signal(false);error=signal("");
  constructor(){this.load();this.timer=setInterval(()=>this.load(false),15_000);}
  ngOnDestroy(){if(this.timer)clearInterval(this.timer);}
  load(showSpinner=true){if(showSpinner)this.loading.set(true);this.http.get<VrStatus>("/api/vr/sankt-poelten/status").subscribe({next:value=>{this.status.set(value);this.loading.set(false);this.error.set("");},error:({status})=>{this.loading.set(false);this.error.set(status===403?"У вас нет доступа к локации Санкт-Пёльтен.":"Не удалось проверить VR-подключение.");}});}
  launch(){const panel=window.open("about:blank","_blank");this.launching.set(true);this.error.set("");this.http.post<{url:string}>("/api/vr/sankt-poelten/launch",{}).subscribe({next:result=>{this.launching.set(false);if(panel)panel.location.href=result.url;else window.location.href=result.url;},error:()=>{panel?.close();this.launching.set(false);this.error.set("Не удалось открыть VR-панель.");}});}
  latency(value:EndpointStatus|undefined){return value?.online&&value.latencyMs!==null?`Ответ ${value.latencyMs} мс`:"Нет ответа";}
}
