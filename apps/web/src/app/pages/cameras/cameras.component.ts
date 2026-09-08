import { Component, ElementRef, HostListener, OnDestroy, ViewChild, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import QRCode from "qrcode";
import { io, Socket } from "socket.io-client";

type Location={id:string;name:string};
type Room={id:string;name:string;location_id:string;location_name:string};
type Camera={id:string;room_id:string|null;room_name:string|null;location_id:string|null;name:string;provider:"RTSP"|"ONVIF"|"TUYA";status:string;plan_x:number|null;plan_y:number|null};
type ZoneType="GAME"|"VR"|"CORRIDOR"|"RECEPTION"|"LOCKERS"|"TECHNICAL"|"STORAGE"|"RESTROOM"|"OTHER";
type Zone={id?:string;name:string;type:ZoneType;color:string;x:number;y:number;width:number;height:number;room_id?:string|null;roomId?:string|null};
type BackgroundMode="CONTAIN"|"COVER"|"CUSTOM";
type Plan={backgroundImage:string|null;backgroundMode:BackgroundMode;backgroundScale:number;backgroundX:number;backgroundY:number;zones:Zone[]};
type Drag={kind:"camera"|"zone"|"resize"|"draw";id:string;startX:number;startY:number;originX:number;originY:number;originW:number;originH:number};

@Component({
  selector:"app-cameras",standalone:true,imports:[FormsModule,RouterLink],
  template:`
<main [class.camera-only]="isCameraViewer()">@if(!isCameraViewer()){<aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="sessions-nav" routerLink="/sessions">Сессии</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a class="active" routerLink="/cameras">Камеры</a>@if(canConfigureCameraSettings()){<a class="camera-settings-link" routerLink="/camera-settings">Настройки камер</a>}<a routerLink="/inventory">Инвентарь</a><a routerLink="/users">Пользователи</a></nav></aside>}
  <section>
    <header><div><h2>{{isCameraViewer()?"Доступные камеры":"Камеры на плане"}}</h2><p>{{isCameraViewer()?"Вам показаны только разрешённые камеры":"Выберите локацию и камеры прямо на схеме"}}</p></div><div class="header-actions">@if(canManageCameras()&&selectedIds().length){<button (click)="createParentQr()">QR для родителя</button>}@if(isOwner()){<button class="secondary" (click)="toggleEdit()">{{editing()?"Закрыть редактор":"Настроить план"}}</button>}@if(canManageCameras()){<button class="secondary" (click)="syncTuya()" [disabled]="syncing()">{{syncing()?"Синхронизация…":"↻ Tuya"}}</button>}</div></header>
    @if(qrImage()){<div class="qr-backdrop" (click)="closeQr()"><section class="qr-card" (click)="$event.stopPropagation()"><h3>Доступ для родителя</h3><p>QR открывает только {{qrCameraCount()}} выбранных камер и действует 24 часа.</p><img [src]="qrImage()" alt="QR-код доступа к камерам"><small>{{qrUrl()}}</small><div><button class="danger" (click)="revokeQr()">Отозвать доступ</button><button class="secondary" (click)="closeQr()">Закрыть</button></div></section></div>}
    <div class="location-tabs">@for(location of locations();track location.id){<button [class.active]="location.id===locationId()" (click)="selectLocation(location.id)">{{location.name}}</button>}</div>
    @if(error()){<p class="error">{{error()}}</p>} @if(notice()){<p class="notice">{{notice()}}</p>}

    @if(editing()){
      <div class="editor-bar">
        <label class="upload">Загрузить фон<input type="file" accept="image/png,image/jpeg,image/webp" (change)="uploadBackground($event)"></label>
        @if(backgroundImage()){<button class="ghost" (click)="backgroundImage.set(null)">Убрать фон</button>}
        @if(backgroundImage()){<label class="background-control">Режим<select [ngModel]="backgroundMode()" (ngModelChange)="backgroundMode.set($event)"><option value="CONTAIN">Вместить</option><option value="COVER">Заполнить</option><option value="CUSTOM">Свой размер</option></select></label>
        @if(backgroundMode()==="CUSTOM"){<label class="background-control">Размер {{backgroundScale()}}%<input type="range" min="10" max="300" [ngModel]="backgroundScale()" (ngModelChange)="backgroundScale.set(+$event)"></label>}
        <label class="background-control">X {{backgroundX()}}%<input type="range" min="0" max="100" [ngModel]="backgroundX()" (ngModelChange)="backgroundX.set(+$event)"></label>
        <label class="background-control">Y {{backgroundY()}}%<input type="range" min="0" max="100" [ngModel]="backgroundY()" (ngModelChange)="backgroundY.set(+$event)"></label>}
        <button class="ghost" [class.active]="drawing()" (click)="drawing.set(!drawing())">▱ Нарисовать зону</button>
        <span class="editor-help">{{drawing()?"Проведите мышью по плану":"Перетаскивайте зоны, их угол и камеры"}}</span>
        <button (click)="savePlan()" [disabled]="saving()">{{saving()?"Сохраняем…":"Сохранить план"}}</button>
      </div>
      <div class="zone-editor">
        <label>Название<input [(ngModel)]="zoneDraft.name" (ngModelChange)="applyZoneDraft()" placeholder="Коридор"></label>
        <label>Тип<select [(ngModel)]="zoneDraft.type" (ngModelChange)="applyZoneDraft()"><option value="GAME">Игровая зона</option><option value="VR">VR</option><option value="CORRIDOR">Коридор</option><option value="RECEPTION">Ресепшен</option><option value="LOCKERS">Шкафчики</option><option value="TECHNICAL">Техническая</option><option value="STORAGE">Склад</option><option value="RESTROOM">Санузел</option><option value="OTHER">Другая</option></select></label>
        <label>Цвет<input type="color" [(ngModel)]="zoneDraft.color" (ngModelChange)="applyZoneDraft()"></label>
        <label>Связать с квест-комнатой<select [(ngModel)]="zoneDraft.roomId" (ngModelChange)="applyZoneDraft()"><option value="">Не связывать</option>@for(room of locationRooms();track room.id){<option [value]="room.id">{{room.name}}</option>}</select></label>
      </div>
    }

    @if(locationId()){
      <div class="plan-layout"><div #plan class="plan" [class.has-background]="!!backgroundImage()" [class.editing]="editing()" [class.drawing]="drawing()" [style.background-image]="backgroundImage()?'url('+backgroundImage()+')':null" [style.background-size]="backgroundSize()" [style.background-position]="backgroundX()+'% '+backgroundY()+'%'" (pointerdown)="planDown($event)">
        @for(zone of zones();track zone.id||$index){<div class="zone" [class.selected-zone]="selectedZone()===zone" [style.left.%]="zone.x" [style.top.%]="zone.y" [style.width.%]="zone.width" [style.height.%]="zone.height" [style.border-color]="zone.color" [style.background]="zone.color+'25'" (pointerdown)="zoneDown($event,zone,'zone')" (click)="selectZone(zone)">
          <span>{{zone.name}}<small>{{zoneTypeName(zone.type)}}</small></span>
          @if(editing()){<button type="button" class="zone-delete" (pointerdown)="$event.stopPropagation()" (click)="deleteZone($event,zone)">×</button><i class="resize" (pointerdown)="zoneDown($event,zone,'resize')"></i>}
        </div>}
        @for(camera of locationCameras();track camera.id){<button class="camera-pin" [class.online]="camera.status==='ONLINE'" [class.selected]="isSelected(camera.id)" [class.unplaced]="camera.plan_x==null" [class.has-people]="(aiStates()[camera.id]?.peopleCount||0)>0" [style.left.%]="cameraX(camera)" [style.top.%]="cameraY(camera)" (pointerdown)="cameraDown($event,camera)" (click)="cameraClick($event,camera)" [title]="camera.name + ((aiStates()[camera.id]?.peopleCount||0) > 0 ? ' (Людей: ' + aiStates()[camera.id].peopleCount + ')' : '')">
          @if((aiStates()[camera.id]?.peopleCount||0)>0){
            <span class="ai-pin-count">{{aiStates()[camera.id].peopleCount}}</span>
          }@else{
            <b>●</b>
          }
        </button>}
        @if(!backgroundImage()&&!zones().length){<div class="plan-empty"><b>План ещё не настроен</b><span>@if(isOwner()){Откройте редактор, загрузите фон или нарисуйте зоны.}@else{Владелец ещё не опубликовал план этой локации.}</span></div>}
      </div><aside class="camera-list"><div class="camera-list-head"><b>Камеры</b><span>{{locationCameras().length}}</span></div>
        @for(camera of locationCameras();track camera.id){<div class="camera-row" [class.selected]="isSelected(camera.id)" (click)="listCameraClick(camera)">
          <i [class.online]="camera.status==='ONLINE'"></i>
          @if(renamingId()===camera.id){<input #nameInput [value]="camera.name" (click)="$event.stopPropagation()" (keydown.enter)="rename(camera,nameInput.value)" (keydown.escape)="renamingId.set(null)"><button class="name-save" (click)="$event.stopPropagation();rename(camera,nameInput.value)">✓</button>}
          @else{<span><b>{{camera.name}}</b><small>{{camera.room_name||"Без игровой комнаты"}}</small></span>
            @if(aiStates()[camera.id]; as ai){
              <span class="camera-row-ai-badge" [class.occupied]="ai.peopleCount > 0" [title]="ai.occupied ? 'В кадре обнаружены люди' : 'Комната пуста'">
                👥 {{ai.peopleCount}}
              </span>
            }
            @if(canManageCameras()){<button class="name-edit" title="Переименовать" (click)="$event.stopPropagation();renamingId.set(camera.id)">✎</button>}}
        </div>}@empty{<p class="no-cameras">В этой локации камер нет.</p>}
      </aside></div>
      <div class="plan-legend"><span><i class="online-dot"></i> Онлайн</span><span><i></i> Офлайн</span><b>Выбрано {{selectedCameras().length}} из {{locationCameras().length}}</b><button class="ghost" (click)="selectOnline()">Выбрать все онлайн</button><button class="ghost" (click)="clearSelection()">Снять выбор</button></div>
    }

    @if(!selectedCameras().length){<div class="empty compact"><b>Камеры не выбраны</b><span>Нажмите на маркеры камер на плане — они появятся в плавающем окне.</span></div>}
  </section></main>`,
  styles:[`
    .camera-only>section{width:100%!important;max-width:none!important;margin-left:0!important}
    .qr-backdrop{position:fixed;z-index:1200;inset:0;display:grid;place-items:center;padding:20px;background:#10182899;backdrop-filter:blur(5px)}.qr-card{display:grid;width:min(420px,100%);place-items:center;padding:25px;border-radius:16px;background:#fff;box-shadow:0 30px 80px #0005;text-align:center}.qr-card h3{margin:0;font-size:21px}.qr-card p{color:var(--muted)}.qr-card img{width:260px;max-width:100%;border-radius:10px}.qr-card small{max-width:100%;margin:10px 0 18px;overflow-wrap:anywhere;color:var(--muted)}.qr-card>div{display:flex;gap:9px}.qr-card .danger{background:#b42318}
    .camera-settings-link{margin:2px 0 6px!important}
    .header-actions,.location-tabs,.editor-bar,.plan-legend{display:flex;gap:10px;align-items:center}.secondary,.ghost,.location-tabs button{background:#eef1f6;color:#344054;box-shadow:none}.location-tabs{margin:22px 0 14px;flex-wrap:wrap}.location-tabs button.active,.ghost.active{background:#4058df;color:white}.notice{padding:12px 14px;border-radius:8px;background:#ecfdf3;color:#067647}
    .editor-bar{flex-wrap:wrap;padding:12px;background:#fff;border:1px solid var(--line);border-radius:12px 12px 0 0}.editor-help{margin-right:auto;color:var(--muted);font-size:12px}.upload{display:inline-flex;align-items:center;padding:10px 14px;border-radius:8px;background:#eef1f6;font-weight:700;cursor:pointer}.upload input{display:none}.background-control{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)}.background-control select{padding:7px}.background-control input{width:95px}
    .zone-editor{display:grid;grid-template-columns:1fr 180px 90px 1fr;gap:10px;padding:12px;background:#f8f9fc;border:1px solid var(--line);border-top:0}.zone-editor label{font-size:11px;color:var(--muted)}.zone-editor input,.zone-editor select{margin-top:5px;padding:8px;width:100%}
    .plan-layout{display:grid;grid-template-columns:minmax(0,1fr) 280px;gap:14px}.plan{position:relative;overflow:hidden;min-height:570px;aspect-ratio:16/9;border:1px solid #d9deea;border-radius:14px;background-color:#f7f8fb;background-repeat:no-repeat;background-image:linear-gradient(#dfe4ec 1px,transparent 1px),linear-gradient(90deg,#dfe4ec 1px,transparent 1px);background-size:25px 25px;touch-action:none;user-select:none}.plan.has-background{background-repeat:no-repeat}.plan.drawing{cursor:crosshair}
    .camera-list{position:static;width:auto;padding:0;overflow:auto;max-height:570px;background:#fff;border:1px solid var(--line);border-radius:14px;color:var(--ink)}.camera-list-head{display:flex;justify-content:space-between;padding:17px;border-bottom:1px solid var(--line)}.camera-list-head span{padding:2px 8px;border-radius:999px;background:#eef1f6;color:var(--muted)}.camera-row{display:grid;grid-template-columns:10px minmax(0,1fr) auto;gap:10px;align-items:center;padding:12px 14px;border-bottom:1px solid #eef0f4;cursor:pointer}.camera-row:hover{background:#f8f9fc}.camera-row.selected{background:#eef1ff}.camera-row>i{width:9px;height:9px;border-radius:50%;background:#98a2b3}.camera-row>i.online{background:#079455}.camera-row span b,.camera-row span small{display:block;overflow:hidden;text-overflow:ellipsis}.camera-row span small{margin-top:3px;color:var(--muted);font-size:10px}.camera-row input{min-width:0;width:100%;padding:7px}.name-edit,.name-save{padding:6px 8px;background:#eef1f6;color:#344054;box-shadow:none}.name-save{background:#dcfae6;color:#067647}.no-cameras{padding:18px;color:var(--muted)}
    .zone{position:absolute;display:grid;place-items:center;min-width:20px;min-height:20px;border:2px solid;border-radius:5px;color:#1e293b;cursor:default}.editing .zone{cursor:move}.zone span{text-align:center;font-weight:800;pointer-events:none}.zone small{display:block;margin-top:3px;font-size:9px;font-weight:600;opacity:.65}.selected-zone{outline:3px solid #4058df55}.zone-delete{position:absolute;right:3px;top:3px;padding:2px 7px;background:#fff;color:#b42318;box-shadow:none}.resize{position:absolute;right:-3px;bottom:-3px;width:14px;height:14px;border-radius:3px;background:#4058df;cursor:nwse-resize}
    .camera-pin{position:absolute;z-index:4;display:grid;place-items:center;width:24px;height:24px;min-width:24px;padding:0;border:2px solid #fff;border-radius:50%;transform:translate(-12px,-12px);background:#667085;color:white;box-shadow:0 3px 10px #0004;transition:none}.camera-pin:hover,.camera-pin:focus{transform:translate(-12px,-12px)}.camera-pin b{font-size:10px;line-height:1}.camera-pin.online{background:#079455}.camera-pin.selected{outline:4px solid #4058df66}.editing .camera-pin{cursor:grab}.camera-pin.unplaced{opacity:.75}
    .camera-pin.has-people{background:#d92d20!important;border-color:#fff;box-shadow:0 0 0 3px #fda29b}
    .ai-pin-count{font-size:11px;font-weight:900;line-height:1}
    .camera-row-ai-badge{margin-left:auto;font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px;background:#f2f4f7;color:#475467}
    .camera-row-ai-badge.occupied{background:#fee4e2;color:#b42318;font-weight:800}
    .plan-empty{position:absolute;inset:0;display:grid;place-content:center;text-align:center;color:var(--muted);pointer-events:none}.plan-empty b{color:var(--ink);font-size:18px}.plan-empty span{margin-top:8px}.plan-legend{justify-content:flex-end;flex-wrap:wrap;margin-top:10px;color:var(--muted);font-size:12px}.plan-legend b{margin-left:auto;color:var(--ink)}.plan-legend i{display:inline-block;width:9px;height:9px;margin-right:5px;border-radius:50%;background:#667085}.plan-legend .online-dot{background:#079455}
    .empty.compact{padding:30px}.camera-grid{grid-template-columns:repeat(auto-fit,minmax(min(420px,100%),1fr))}.camera-info{display:flex;align-items:center;justify-content:space-between;padding:14px}.camera-info span{display:block;margin-top:4px;color:var(--muted);font-size:11px}
    @media(max-width:1100px){.plan-layout{grid-template-columns:1fr}.camera-list{max-height:280px}}@media(max-width:900px){.zone-editor{grid-template-columns:1fr 1fr}.plan{min-height:420px}.plan-legend b{width:100%;margin:0}}@media(max-width:600px){.location-tabs{display:grid;grid-template-columns:1fr 1fr}.location-tabs button{width:100%;min-height:42px}.editor-bar{align-items:stretch;flex-direction:column}.editor-bar button,.editor-bar .upload{justify-content:center;width:100%;min-height:42px}.background-control{align-items:stretch;flex-direction:column}.background-control input{width:100%}.zone-editor{grid-template-columns:1fr}.plan{min-height:360px;aspect-ratio:3/4}.camera-list{max-height:340px}.plan-legend{justify-content:flex-start}.plan-legend button{flex:1}.camera-info{align-items:flex-start;flex-direction:column;gap:10px}}
  `]
})
export class CamerasComponent implements OnDestroy{
  private http=inject(HttpClient);
  private socket?:Socket;
  @ViewChild("plan") planRef?:ElementRef<HTMLElement>;
  locations=signal<Location[]>([]);rooms=signal<Room[]>([]);cameras=signal<Camera[]>([]);locationId=signal("");zones=signal<Zone[]>([]);backgroundImage=signal<string|null>(null);backgroundMode=signal<BackgroundMode>("CONTAIN");backgroundScale=signal(100);backgroundX=signal(50);backgroundY=signal(50);
  aiStates=signal<Record<string,{peopleCount:number;occupied:boolean;motion:boolean}>>({});
  editing=signal(false);drawing=signal(false);saving=signal(false);syncing=signal(false);error=signal("");notice=signal("");selectedIds=signal<string[]>([]);
  renamingId=signal<string|null>(null);
  qrImage=signal("");qrUrl=signal("");qrShareId=signal("");qrCameraCount=signal(0);
  selectedZone=signal<Zone|null>(null);
  zoneDraft:{name:string;type:ZoneType;color:string;roomId:string}={name:"Новая зона",type:"OTHER",color:"#64748b",roomId:""};private drag:Drag|null=null;private suppressClick=false;
  isOwner(){try{return JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1])).role==="OWNER"}catch{return false}}
  isCameraViewer(){try{return JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1])).role==="CAMERA_VIEWER"}catch{return false}}
  canConfigureCameraSettings(){try{return ["OWNER","ADMIN"].includes(JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1])).role)}catch{return false}}
  canManageCameras(){try{const p=JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1])).permissions||[];return p.includes("*")||p.includes("cameras:*")||p.includes("cameras:manage")}catch{return false}}
  constructor(){
    try{const stored=JSON.parse(localStorage.getItem("questcontrol.selectedCameras")||"[]");this.selectedIds.set(Array.isArray(stored)?stored:[])}catch{}
    this.http.get<Location[]>("/api/locations").subscribe({next:l=>{this.locations.set(l);if(l[0])this.selectLocation(l[0].id)}});
    this.http.get<Room[]>("/api/rooms").subscribe({next:r=>this.rooms.set(r)});
    this.loadCameras();
    this.initSocket();
  }
  ngOnDestroy(){this.socket?.disconnect()}
  private initSocket(){
    this.fetchAiStates();
    try{
      const token=sessionStorage.getItem("access_token");
      if(token){
        this.socket=io({path:"/ws",auth:{token}});
        this.socket.on("camera:ai:state",(data:{cameraId:string;peopleCount:number;occupied:boolean;motion:boolean})=>{
          if(data?.cameraId){
            this.aiStates.update(v=>({...v,[data.cameraId]:data}));
          }
        });
      }
    }catch{}
  }
  fetchAiStates(){
    this.http.get<Record<string,{peopleCount:number;occupied:boolean;motion:boolean}>>("/api/cameras/ai/states").subscribe({
      next:st=>{if(st)this.aiStates.set(st)},
      error:()=>{}
    });
  }
  loadCameras(){this.http.get<Camera[]>("/api/cameras").subscribe({next:c=>{this.cameras.set(c);if(this.isCameraViewer()){this.selectedIds.set(c.map(camera=>camera.id));this.persistSelection()}},error:()=>this.error.set("Не удалось загрузить камеры.")})}
  selectLocation(id:string){this.locationId.set(id);this.editing.set(false);this.http.get<Plan>(`/api/locations/${id}/plan`).subscribe({next:p=>{this.backgroundImage.set(p.backgroundImage);this.backgroundMode.set(p.backgroundMode||"CONTAIN");this.backgroundScale.set(+(p.backgroundScale||100));this.backgroundX.set(+(p.backgroundX??50));this.backgroundY.set(+(p.backgroundY??50));this.zones.set(p.zones.map(z=>({...z,x:+z.x,y:+z.y,width:+z.width,height:+z.height,roomId:z.room_id||""})));},error:()=>this.error.set("Не удалось загрузить план локации.")})}
  backgroundSize(){return this.backgroundMode()==="CONTAIN"?"contain":this.backgroundMode()==="COVER"?"cover":`${this.backgroundScale()}% auto`}
  locationCameras(){return this.cameras().filter(c=>c.location_id===this.locationId())}
  locationRooms(){return this.rooms().filter(r=>r.location_id===this.locationId())}
  cameraX(c:Camera){return c.plan_x==null?4+(this.locationCameras().indexOf(c)%4)*22:+c.plan_x}
  cameraY(c:Camera){return c.plan_y==null?92-Math.floor(this.locationCameras().indexOf(c)/4)*7:+c.plan_y}
  toggleEdit(){this.editing.set(!this.editing());this.drawing.set(false)}
  uploadBackground(event:Event){const file=(event.target as HTMLInputElement).files?.[0];if(!file)return;if(file.size>5_000_000){this.error.set("Файл фона должен быть меньше 5 МБ.");return}this.error.set("");const reader=new FileReader();reader.onload=()=>this.backgroundImage.set(String(reader.result));reader.readAsDataURL(file)}
  point(event:PointerEvent){const rect=this.planRef!.nativeElement.getBoundingClientRect();return{x:Math.max(0,Math.min(100,(event.clientX-rect.left)/rect.width*100)),y:Math.max(0,Math.min(100,(event.clientY-rect.top)/rect.height*100))}}
  planDown(e:PointerEvent){if(!this.editing()||!this.drawing()||e.target!==this.planRef?.nativeElement)return;const p=this.point(e);const zone:Zone={name:this.zoneDraft.name||"Новая зона",type:this.zoneDraft.type,color:this.zoneDraft.color,x:p.x,y:p.y,width:2,height:2,roomId:this.zoneDraft.roomId||null};this.zones.update(z=>[...z,zone]);this.selectedZone.set(zone);this.drag={kind:"draw",id:"",startX:p.x,startY:p.y,originX:p.x,originY:p.y,originW:2,originH:2};this.capture(e)}
  zoneDown(e:PointerEvent,z:Zone,kind:"zone"|"resize"){if(!this.editing())return;e.stopPropagation();const p=this.point(e);this.selectedZone.set(z);this.drag={kind,id:"",startX:p.x,startY:p.y,originX:z.x,originY:z.y,originW:z.width,originH:z.height};this.capture(e)}
  cameraDown(e:PointerEvent,c:Camera){if(!this.editing())return;e.stopPropagation();const p=this.point(e);this.drag={kind:"camera",id:c.id,startX:p.x,startY:p.y,originX:this.cameraX(c),originY:this.cameraY(c),originW:0,originH:0};this.capture(e)}
  capture(e:PointerEvent){this.suppressClick=false;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)}
  @HostListener("document:pointermove",["$event"]) move(e:PointerEvent){if(!this.drag)return;const p=this.point(e),dx=p.x-this.drag.startX,dy=p.y-this.drag.startY;if(Math.abs(dx)+Math.abs(dy)>.3)this.suppressClick=true;if(this.drag.kind==="camera"){this.cameras.update(cs=>cs.map(c=>c.id===this.drag!.id?{...c,plan_x:Math.max(0,Math.min(100,this.drag!.originX+dx)),plan_y:Math.max(0,Math.min(100,this.drag!.originY+dy)),location_id:this.locationId()}:c));return}const z=this.selectedZone();if(!z)return;if(this.drag.kind==="zone"){z.x=Math.max(0,Math.min(100-z.width,this.drag.originX+dx));z.y=Math.max(0,Math.min(100-z.height,this.drag.originY+dy))}else if(this.drag.kind==="resize"){z.width=Math.max(2,Math.min(100-z.x,this.drag.originW+dx));z.height=Math.max(2,Math.min(100-z.y,this.drag.originH+dy))}else{z.x=Math.min(this.drag.startX,p.x);z.y=Math.min(this.drag.startY,p.y);z.width=Math.max(2,Math.abs(p.x-this.drag.startX));z.height=Math.max(2,Math.abs(p.y-this.drag.startY))}this.zones.update(v=>[...v])}
  @HostListener("document:pointerup") up(){if(this.drag?.kind==="draw")this.drawing.set(false);this.drag=null}
  selectZone(z:Zone){if(this.editing()){this.selectedZone.set(z);this.zoneDraft={name:z.name,type:z.type,color:z.color,roomId:z.roomId||""}}}
  applyZoneDraft(){const z=this.selectedZone();if(!z)return;z.name=this.zoneDraft.name||"Без названия";z.type=this.zoneDraft.type;z.color=this.zoneDraft.color;z.roomId=this.zoneDraft.roomId||null;this.zones.update(v=>[...v])}
  deleteZone(e:Event,z:Zone){e.stopPropagation();this.zones.update(v=>v.filter(x=>x!==z));if(this.selectedZone()===z)this.selectedZone.set(null)}
  savePlan(){this.saving.set(true);this.error.set("");const payload={backgroundImage:this.backgroundImage(),backgroundMode:this.backgroundMode(),backgroundScale:this.backgroundScale(),backgroundX:this.backgroundX(),backgroundY:this.backgroundY(),zones:this.zones().map(z=>({id:z.id,name:z.name,type:z.type,color:z.color,x:z.x,y:z.y,width:z.width,height:z.height,roomId:z.roomId||null})),cameras:this.locationCameras().map(c=>({id:c.id,x:this.cameraX(c),y:this.cameraY(c)}))};this.http.put(`/api/locations/${this.locationId()}/plan`,payload).subscribe({next:()=>{this.saving.set(false);this.editing.set(false);this.notice.set("План локации сохранён.");this.loadCameras();this.selectLocation(this.locationId())},error:({status,error})=>{this.saving.set(false);this.error.set(status===413?"Изображение слишком большое для сервера.":error?.error==="INVALID_INPUT"?"План содержит слишком большое или неподдерживаемое изображение.":"Не удалось сохранить план.")}})}
  zoneTypeName(t:ZoneType){return({GAME:"Игровая",VR:"VR",CORRIDOR:"Коридор",RECEPTION:"Ресепшен",LOCKERS:"Шкафчики",TECHNICAL:"Техническая",STORAGE:"Склад",RESTROOM:"Санузел",OTHER:"Другая"})[t]}
  cameraClick(e:Event,c:Camera){e.stopPropagation();if(this.editing()||this.suppressClick){this.suppressClick=false;return}this.toggle(c)}
  listCameraClick(c:Camera){if(this.renamingId()!==c.id)this.toggle(c)}
  rename(c:Camera,name:string){const value=name.trim();if(value.length<2){this.error.set("Название камеры должно содержать минимум 2 символа.");return}this.http.patch<Camera>(`/api/cameras/${c.id}/name`,{name:value}).subscribe({next:updated=>{this.cameras.update(items=>items.map(item=>item.id===c.id?{...item,name:updated.name}:item));this.renamingId.set(null);this.notice.set("Название камеры сохранено.")},error:()=>this.error.set("Не удалось переименовать камеру.")})}
  isSelected(id:string){return this.selectedIds().includes(id)} selectedCameras(){const ids=new Set(this.selectedIds());return this.locationCameras().filter(c=>ids.has(c.id))}
  toggle(c:Camera){if(this.isSelected(c.id))this.selectedIds.update(v=>v.filter(id=>id!==c.id));else this.selectedIds.update(v=>[...v,c.id]);this.persistSelection()}
  selectOnline(){for(const c of this.locationCameras().filter(c=>c.status==="ONLINE"&&!this.isSelected(c.id)))this.selectedIds.update(v=>[...v,c.id]);this.persistSelection()}clearSelection(){this.selectedIds.set([]);this.persistSelection()}
  private persistSelection(){localStorage.setItem("questcontrol.selectedCameras",JSON.stringify(this.selectedIds()));window.dispatchEvent(new Event("questcontrol-camera-selection"))}
  syncTuya(){this.syncing.set(true);this.http.post<any>("/api/cameras/sync/tuya",{}).subscribe({next:r=>{this.syncing.set(false);this.notice.set(`Tuya: камер ${r.cameras}, добавлено ${r.created}.`);this.loadCameras()},error:()=>{this.syncing.set(false);this.error.set("Не удалось синхронизировать Tuya.")}})}
  createParentQr(){const allowed=new Set(this.cameras().map(camera=>camera.id));const cameraIds=this.selectedIds().filter(id=>allowed.has(id));if(!cameraIds.length)return;this.http.post<{id:string;token:string}>("/api/camera-shares",{cameraIds,expiresInHours:24}).subscribe({next:async share=>{const url=`${location.origin}/watch/${share.token}`;this.qrShareId.set(share.id);this.qrUrl.set(url);this.qrCameraCount.set(cameraIds.length);this.qrImage.set(await QRCode.toDataURL(url,{width:520,margin:2,errorCorrectionLevel:"M"}))},error:()=>this.error.set("Не удалось создать QR-код доступа.")})}
  revokeQr(){const id=this.qrShareId();if(!id)return;this.http.delete(`/api/camera-shares/${id}`).subscribe({next:()=>{this.closeQr();this.notice.set("Доступ по QR-коду отозван.")},error:()=>this.error.set("Не удалось отозвать доступ.")})}
  closeQr(){this.qrImage.set("");this.qrUrl.set("");this.qrShareId.set("");this.qrCameraCount.set(0)}
}
