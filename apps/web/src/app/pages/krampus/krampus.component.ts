import { Component, inject, OnDestroy, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";
import { SlicePipe } from "@angular/common";
import { Subscription, forkJoin, interval, startWith, switchMap } from "rxjs";

type Room={id:string;name:string};
@Component({
  selector:"app-krampus",standalone:true,imports:[RouterLink,SlicePipe],
  template:`
  <main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/cameras">Камеры</a><a class="active" routerLink="/krampus">Krampus House</a></nav></aside>
  <section><header><div><h2>Krampus House</h2><p>Управление комнатой через защищённый room-agent</p></div><span class="connection" [class.online]="status()?.serial?.enabled">{{status()?.serial?.enabled?"Arduino online":"Нет связи"}}</span></header>
  @if(error()){<p class="error">{{error()}}</p>}
  @if(!roomId()){<div class="empty"><b>Комната не настроена</b><span>Создайте комнату и привяжите к ней устройство с agent_id.</span></div>}
  @else{
    <div class="krampus-actions"><button class="start" (click)="command('START')">START</button><button (click)="command('STATUS')">STATUS</button><button class="danger-solid" (click)="command('RESET')">RESET</button><button class="danger-solid" (click)="command('ESTOP')">ESTOP</button></div>
    <div class="krampus-layout">
      <article class="control-card"><h3>Свет и атмосфера</h3><div class="button-grid">@for(c of atmosphere;track c){<button (click)="command(c)">{{c}}</button>}</div></article>
      <article class="control-card"><h3>Механизмы</h3><div class="button-grid">@for(c of mechanisms;track c){<button (click)="command(c)">{{c}}</button>}</div></article>
      <article class="control-card"><h3>Печка</h3><div class="button-grid">@for(c of oven;track c){<button (click)="command(c)">{{c}}</button>}</div></article>
      <article class="control-card"><h3>Звуки</h3><div class="button-grid"><button (click)="sound('play','alert.mp3')">ALERT</button><button (click)="sound('play','calling.mp3')">CALLING</button><button class="danger-solid" (click)="sound('stop')">STOP</button></div></article>
    </div>
    <h3>Датчики</h3><div class="sensor-grid">@for(item of sensorEntries();track item[0]){<article><span>{{item[0]}}</span><b [class.active]="item[1]===1">{{item[1]}}</b></article>}</div>
    <h3>Serial-консоль</h3><div class="terminal">@for(line of logLines();track $index){<div><time>{{line.at|slice:11:19}}</time><b>{{line.direction}}</b><code>{{line.line}}</code></div>}@empty{<span>Нет данных</span>}</div>
  }</section></main>`,
  styles:[`
  .connection{padding:8px 12px;border-radius:20px;background:#feecef;color:#ad2436}.connection.online{background:#e4f7ed;color:#137344}
  .krampus-actions{display:flex;gap:10px;margin:24px 0}.krampus-actions button{min-width:110px}.start{background:#168653}.danger-solid{background:#bd3042!important}
  .krampus-layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.control-card{background:white;border:1px solid #e1e5ed;border-radius:11px;padding:18px}.control-card h3{margin-top:0}
  .button-grid{display:flex;flex-wrap:wrap;gap:8px}.button-grid button{background:#eef1f6;color:#273248}
  .sensor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.sensor-grid article{display:flex;justify-content:space-between;background:white;padding:12px;border:1px solid #e1e5ed;border-radius:8px}.sensor-grid b{color:#b32d3e}.sensor-grid b.active{color:#168653}
  .terminal{height:280px;overflow:auto;background:#101622;color:#d8dfec;border-radius:10px;padding:14px}.terminal div{display:grid;grid-template-columns:70px 40px 1fr;gap:8px;padding:3px}.terminal time{color:#78859d}.terminal b{color:#7c8cff}.terminal code{white-space:pre-wrap}
  @media(max-width:900px){.krampus-layout{grid-template-columns:1fr}.krampus-actions{flex-wrap:wrap}}
  `]
})
export class KrampusComponent implements OnDestroy{
  private http=inject(HttpClient);private poll?:Subscription;
  roomId=signal("");status=signal<any>(null);sensors=signal<Record<string,number>>({});logLines=signal<any[]>([]);error=signal("");
  atmosphere=["LIGHT UV","LIGHT WHITE","LIGHT OK","LIGHT OFF","LIGHT RESET","MASK SOUND"];
  mechanisms=["PUZZLE SOLVE","PUZZLE RESET","BEAR SOUND","BEAR OPEN","BEAR CLOSE","DOOR OPEN","DOOR CLOSE","TABLE OPEN","TABLE CLOSE"];
  oven=["OVEN SOLVED","OVEN RESET","OVEN UV ON","OVEN UV OFF","OVEN LIGHT ON","OVEN LIGHT OFF","OVEN MOVE ON","OVEN MOVE OFF","OVEN FOG ON","OVEN FOG OFF"];
  constructor(){this.http.get<Room[]>("/api/rooms").subscribe({next:rooms=>{const room=rooms.find(r=>/krampus/i.test(r.name))||rooms[0];if(room){this.roomId.set(room.id);this.startPolling();}},error:()=>this.error.set("Не удалось загрузить комнаты.")});}
  startPolling(){this.poll=interval(2000).pipe(startWith(0),switchMap(()=>forkJoin({status:this.http.get<any>(`/api/rooms/${this.roomId()}/krampus/status`),sensors:this.http.get<any>(`/api/rooms/${this.roomId()}/krampus/sensors`),logs:this.http.get<any>(`/api/rooms/${this.roomId()}/krampus/logs`)}))).subscribe({next:r=>{this.status.set(r.status);this.sensors.set(r.sensors.values||{});this.logLines.set((r.logs.lines||[]).slice(-150));this.error.set("");},error:()=>this.error.set("Room-agent или сервер Krampus недоступен.")});}
  command(value:string){this.http.post(`/api/rooms/${this.roomId()}/krampus/command`,{command:`ADMIN ${value}`}).subscribe({error:()=>this.error.set("Команда не доставлена.")});}
  sound(action:"play"|"stop",sound?:string){this.http.post(`/api/rooms/${this.roomId()}/krampus/sound`,{action,sound}).subscribe({error:()=>this.error.set("Звуковая команда не доставлена.")});}
  sensorEntries(){return Object.entries(this.sensors());}
  ngOnDestroy(){this.poll?.unsubscribe();}
}
