import { Component, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";

type Location={id:string;name:string};
type Zone={id:string;name:string;type:string;room_id:string|null};
type Camera={id:string;name:string;provider:string;status:string;location_id:string|null;plan_zone_id:string|null;location_name:string|null;zone_name:string|null;room_name:string|null};

@Component({
  selector:"app-camera-settings",standalone:true,imports:[FormsModule,RouterLink],
  template:`
  <main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a class="camera-settings-link active" routerLink="/camera-settings"><span>⚙</span> Настройки камер</a><a routerLink="/krampus">Krampus House</a><a routerLink="/users">Пользователи</a></nav></aside>
  <section><header><div><h2>Настройки камер</h2><p>Распределение всех камер аккаунта по локациям и зонам плана</p></div><div class="header-actions"><button class="tuya-sync" (click)="syncTuya()" [disabled]="syncing()">{{syncing()?"Синхронизация…":"↻ Синхронизировать с Tuya"}}</button><button class="secondary" (click)="load()">Обновить список</button></div></header>
  @if(error()){<p class="error">{{error()}}</p>}@if(notice()){<p class="notice">{{notice()}}</p>}
  <div class="camera-table"><div class="table-head"><span>Камера</span><span>Локация</span><span>Зона или комната на плане</span><span></span></div>
  @for(camera of cameras();track camera.id){<article>
    <div class="camera-name"><i [class.online]="camera.status==='ONLINE'"></i><span><b>{{camera.name}}</b><small>{{camera.provider}} · {{camera.status}}</small></span></div>
    <select [ngModel]="camera.location_id||''" (ngModelChange)="locationChanged(camera,$event)">@if(isOwner()){<option value="">Не назначена</option>}@else if(!camera.location_id){<option value="" disabled>Выберите локацию</option>}@for(location of locations();track location.id){<option [value]="location.id">{{location.name}}</option>}</select>
    <select [disabled]="!camera.location_id||loadingZones().includes(camera.location_id)" [ngModel]="camera.plan_zone_id||''" (ngModelChange)="zoneChanged(camera,$event)"><option value="">Без зоны</option>@for(zone of zonesFor(camera.location_id);track zone.id){<option [value]="zone.id">{{zone.name}} · {{zoneType(zone.type)}}@if(zone.room_id){ · квест-комната}</option>}</select>
    <div class="assignment">@if(camera.zone_name){<b>{{camera.zone_name}}</b><small>{{camera.room_name||"Обычная зона плана"}}</small>}@else if(camera.location_name){<span>Только локация</span>}@else{<span>Не распределена</span>}</div>
  </article>}@empty{<div class="empty"><b>Камер в аккаунте пока нет</b><span>Выполните синхронизацию Tuya на вкладке камер.</span></div>}</div>
  </section></main>`,
  styles:[`
    .camera-settings-link{width:calc(100% - 18px);margin:5px 0 8px 18px!important;padding:10px 13px!important;border:1px solid #8792ff;background:#4058df!important;color:#fff!important;box-shadow:0 6px 18px #0003}.camera-settings-link span{display:inline-grid;width:22px;height:22px;margin-right:8px;place-items:center;border-radius:6px;background:#fff2;color:#fff;font-size:13px}
    .header-actions{display:flex;gap:10px;align-items:center}.tuya-sync{background:#4058df;color:#fff}.secondary{background:#eef1f6;color:#344054;box-shadow:none}.notice{padding:12px 14px;border-radius:8px;background:#ecfdf3;color:#067647}.camera-table{margin-top:24px;overflow:hidden;border:1px solid var(--line);border-radius:14px;background:#fff}.table-head,.camera-table article{display:grid;grid-template-columns:minmax(190px,1.2fr) minmax(170px,.8fr) minmax(230px,1.1fr) minmax(150px,.7fr);gap:14px;align-items:center;padding:14px 16px}.table-head{background:#f7f8fb;color:var(--muted);font-size:11px;font-weight:700}.camera-table article{border-top:1px solid #edf0f4}.camera-name{display:flex;align-items:center;gap:10px;min-width:0}.camera-name i{width:9px;height:9px;border-radius:50%;background:#98a2b3}.camera-name i.online{background:#079455}.camera-name b,.camera-name small,.assignment b,.assignment small{display:block}.camera-name small,.assignment small,.assignment span{margin-top:3px;color:var(--muted);font-size:10px}.camera-table select{width:100%;min-width:0;padding:9px}.empty{margin:0;border:0}@media(max-width:900px){header{align-items:flex-start}.header-actions{width:100%;flex-wrap:wrap}.table-head{display:none}.camera-table article{grid-template-columns:1fr}.assignment{padding-top:5px}}
  `]
})
export class CameraSettingsComponent{
  private http=inject(HttpClient);private router=inject(Router);
  cameras=signal<Camera[]>([]);locations=signal<Location[]>([]);zones=signal<Record<string,Zone[]>>({});loadingZones=signal<string[]>([]);syncing=signal(false);error=signal("");notice=signal("");
  constructor(){if(!this.canConfigure()){void this.router.navigateByUrl("/cameras");return}this.http.get<Location[]>("/api/locations").subscribe({next:l=>this.locations.set(l)});this.load()}
  isOwner(){try{return JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1])).role==="OWNER"}catch{return false}}
  canConfigure(){try{return ["OWNER","ADMIN"].includes(JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1])).role)}catch{return false}}
  load(){this.http.get<Camera[]>("/api/camera-settings").subscribe({next:c=>{this.cameras.set(c);for(const id of new Set(c.map(x=>x.location_id).filter((x):x is string=>!!x)))this.loadZones(id)},error:()=>this.error.set("Не удалось загрузить настройки камер.")})}
  loadZones(locationId:string){if(this.zones()[locationId]||this.loadingZones().includes(locationId))return;this.loadingZones.update(v=>[...v,locationId]);this.http.get<{zones:Zone[]}>(`/api/locations/${locationId}/plan`).subscribe({next:p=>{this.zones.update(v=>({...v,[locationId]:p.zones}));this.loadingZones.update(v=>v.filter(id=>id!==locationId))},error:()=>this.loadingZones.update(v=>v.filter(id=>id!==locationId))})}
  zonesFor(locationId:string|null){return locationId?this.zones()[locationId]||[]:[]}
  locationChanged(camera:Camera,locationId:string){camera.location_id=locationId||null;camera.plan_zone_id=null;if(locationId)this.loadZones(locationId);this.save(camera)}
  zoneChanged(camera:Camera,zoneId:string){camera.plan_zone_id=zoneId||null;this.save(camera)}
  save(camera:Camera){this.error.set("");this.http.patch(`/api/cameras/${camera.id}/assignment`,{locationId:camera.location_id,zoneId:camera.plan_zone_id}).subscribe({next:()=>{this.notice.set(`Камера «${camera.name}» распределена.`);this.load()},error:()=>{this.error.set("Не удалось сохранить привязку камеры.");this.load()}})}
  syncTuya(){this.syncing.set(true);this.error.set("");this.notice.set("");this.http.post<{cameras:number;created:number}>("/api/cameras/sync/tuya",{}).subscribe({next:r=>{this.syncing.set(false);this.notice.set(`Синхронизация завершена: камер ${r.cameras}, добавлено ${r.created}.`);this.load()},error:()=>{this.syncing.set(false);this.error.set("Не удалось синхронизировать камеры с Tuya.")}})}
  zoneType(type:string){return({GAME:"Игровая",VR:"VR",CORRIDOR:"Коридор",RECEPTION:"Ресепшен",LOCKERS:"Шкафчики",TECHNICAL:"Техническая",STORAGE:"Склад",RESTROOM:"Санузел",OTHER:"Другая"} as Record<string,string>)[type]||type}
}
