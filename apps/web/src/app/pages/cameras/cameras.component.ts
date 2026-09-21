import { Component, ElementRef, HostListener, OnDestroy, ViewChild, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { DatePipe } from "@angular/common";
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
type CameraShare={id:string;expires_at:string;revoked_at:string|null;created_at:string;created_by:string;creator_name:string;camera_names:string[];camera_count:number;active:boolean};

@Component({
  selector:"app-cameras",standalone:true,imports:[FormsModule,RouterLink,DatePipe],
  template:`
<main [class.camera-only]="isCameraViewer()">@if(!isCameraViewer()){<aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="sessions-nav" routerLink="/sessions">Сессии</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a class="active" routerLink="/cameras">Камеры</a>@if(canConfigureCameraSettings()){<a class="camera-settings-link" routerLink="/camera-settings">Настройки камер</a>}<a routerLink="/inventory">Инвентарь</a><a routerLink="/users">Пользователи</a></nav></aside>}
  <section>
    <header><div><span class="page-eyebrow">НАБЛЮДЕНИЕ</span><h2>{{isCameraViewer()?"Доступные камеры":"Камеры"}}</h2><p>{{isCameraViewer()?"Вам показаны только разрешённые камеры":"Выберите локацию, затем нужные камеры на плане"}}</p></div><div class="header-actions">@if(canManageCameras()){<button class="access-button" (click)="openShares()"><span>▦</span> Доступы для родителей @if(activeShareCount()){<b>{{activeShareCount()}}</b>}</button>}<details class="tools-menu"><summary aria-label="Дополнительные действия">•••</summary><div>@if(isOwner()){<button (click)="toggleEdit();closeTools($event)">{{editing()?"Закрыть редактор":"Редактировать план"}}</button>}@if(canManageCameras()){<button (click)="syncTuya();closeTools($event)" [disabled]="syncing()">{{syncing()?"Синхронизация…":"Синхронизировать Tuya"}}</button>}@if(canConfigureCameraSettings()){<a routerLink="/camera-settings">Настройки камер</a>}</div></details></div></header>
    @if(qrImage()){<div class="qr-backdrop" (click)="closeQr()"><section class="qr-card" (click)="$event.stopPropagation()"><button class="modal-close" aria-label="Закрыть" (click)="closeQr()">×</button><span class="modal-kicker">ГОТОВО</span><h3>Доступ для родителя создан</h3><p>Только {{qrCameraCount()}} выбранных камер · действует 24 часа</p><div class="qr-image"><img [src]="qrImage()" alt="QR-код доступа к камерам"></div><small>{{qrUrl()}}</small><div class="qr-actions"><button (click)="copyQrLink()">Копировать ссылку</button><button class="secondary" (click)="downloadQr()">Скачать QR</button></div><button class="danger-link" (click)="revokeQr()">Отозвать этот доступ</button></section></div>}
    @if(sharesOpen()){
      <div class="shares-backdrop" (click)="sharesOpen.set(false)">
        <section class="shares-panel" (click)="$event.stopPropagation()">
          <header>
            <div><span class="modal-kicker">БЕЗОПАСНОСТЬ</span><h3>Доступы для родителей</h3><p>Все созданные QR-ссылки и их текущее состояние</p></div>
            <button class="modal-close" aria-label="Закрыть" (click)="sharesOpen.set(false)">×</button>
          </header>
          <div class="share-summary"><article><b>{{activeShareCount()}}</b><span>активных</span></article><article><b>{{shares().length}}</b><span>всего создано</span></article></div>
          <div class="share-list">
            @if(!sharesLoading()&&activeShareCount()){<p class="share-list-hint">Активные ссылки можно отключить сразу — нажмите «Отозвать доступ».</p>}
            @if(sharesLoading()){<div class="shares-empty">Загружаем доступы…</div>}
            @else{
              @for(share of shares();track share.id){
                <article class="share-row">
                  <div class="share-icon" [class.revoked]="!!share.revoked_at" [class.expired]="!share.active&&!share.revoked_at">▦</div>
                  <div class="share-main">
                    <div class="share-title"><b>{{share.camera_count}} {{cameraWord(share.camera_count)}}</b><span [class.active]="share.active" [class.revoked]="!!share.revoked_at">{{shareStatus(share)}}</span></div>
                    <p>{{shareCameraNames(share)}}</p>
                    <small>Создал: {{share.creator_name}} · {{share.created_at|date:'dd.MM.yyyy, HH:mm'}}</small>
                    <small>{{share.revoked_at?'Отозван':'Действует до'}} {{(share.revoked_at||share.expires_at)|date:'dd.MM.yyyy, HH:mm'}}</small>
                  </div>
                  @if(share.active){<button class="revoke-button" [disabled]="revokingId()===share.id" (click)="revokeShare(share)">{{revokingId()===share.id?'Отзываем…':'Отозвать доступ'}}</button>}
                </article>
              }@empty{<div class="shares-empty"><b>QR-доступов пока нет</b><span>Выберите камеры на плане и создайте первый доступ.</span></div>}
            }
          </div>
        </section>
      </div>
    }
    <div class="workspace-bar"><div class="location-picker"><span>1</span><div><small>Локация</small><div class="location-tabs">@for(location of locations();track location.id){<button [class.active]="location.id===locationId()" (click)="selectLocation(location.id)">{{location.name}}</button>}</div></div></div><div class="selection-step" [class.ready]="selectedCameras().length"><span>2</span><div><small>Камеры</small><b>{{selectedCameras().length?('Выбрано: '+selectedCameras().length):'Выберите на плане'}}</b></div></div>@if(canManageCameras()){<button class="create-access" [disabled]="!selectedCameras().length" (click)="createParentQr()"><span>3</span><div><small>Поделиться</small><b>Создать QR-доступ</b></div></button>}</div>
    @if(error()){<p class="error">{{error()}}</p>} @if(notice()){<p class="notice">{{notice()}}</p>}
    @if(activeControlCamera();as activeCamera){
      <section class="ptz-panel" aria-label="Управление камерой">
        <div class="ptz-copy"><span>УПРАВЛЕНИЕ КАМЕРОЙ</span><b>{{activeCamera.name}}</b><small>Кликните камеру на плане или в списке, затем используйте стрелки клавиатуры либо кнопки.</small></div>
        <div class="ptz-pad" aria-label="Поворот камеры">
          <i></i><button type="button" aria-label="Вверх" (pointerdown)="startPtz($event,'UP')" (pointerup)="stopPtz()" (pointercancel)="stopPtz()" (pointerleave)="stopPtz()">↑</button><i></i>
          <button type="button" aria-label="Влево" (pointerdown)="startPtz($event,'LEFT')" (pointerup)="stopPtz()" (pointercancel)="stopPtz()" (pointerleave)="stopPtz()">←</button><button type="button" aria-label="Остановить" class="ptz-stop" (click)="stopPtz(true)">■</button><button type="button" aria-label="Вправо" (pointerdown)="startPtz($event,'RIGHT')" (pointerup)="stopPtz()" (pointercancel)="stopPtz()" (pointerleave)="stopPtz()">→</button>
          <i></i><button type="button" aria-label="Вниз" (pointerdown)="startPtz($event,'DOWN')" (pointerup)="stopPtz()" (pointercancel)="stopPtz()" (pointerleave)="stopPtz()">↓</button><i></i>
        </div>
        @if(cameraControlError()){<p class="ptz-error">{{cameraControlError()}}</p>}
      </section>
    }

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
    .ptz-panel{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:18px;align-items:center;margin:0 0 14px;padding:14px 16px;border:1px solid #344264;border-radius:14px;background:#111826;color:#eef3ff;box-shadow:0 12px 30px #060a121f}.ptz-copy span{display:block;color:#8d9aff;font-size:9px;font-weight:900;letter-spacing:.12em}.ptz-copy b,.ptz-copy small{display:block}.ptz-copy b{margin-top:4px;font-size:15px}.ptz-copy small{margin-top:4px;color:#9ca9bc;font-size:10px}.ptz-pad{display:grid;grid-template-columns:repeat(3,38px);gap:4px}.ptz-pad>i{display:block}.ptz-pad button{display:grid;width:38px;height:34px;padding:0;place-items:center;border:1px solid #3c4b66;border-radius:8px;background:#1e2a3e;color:#f7f9ff;box-shadow:none;font-size:19px;font-weight:800}.ptz-pad button:hover{background:#2b3d5b;transform:none}.ptz-pad .ptz-stop{background:#293449;color:#aebadd;font-size:13px}.ptz-error{grid-column:1/-1;margin:0;color:#ffb4bf;font-size:10px}.camera-only .ptz-panel{margin-inline:0}
    .page-eyebrow,.modal-kicker{display:block;margin-bottom:5px;color:#5966dd;font-size:9px;font-weight:900;letter-spacing:.14em}.header-actions{position:relative}.access-button{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #dce1eb;box-shadow:0 4px 14px #18213a0c;color:#344054}.access-button span{color:#5966dd;font-size:18px}.access-button b{display:grid;min-width:21px;height:21px;place-items:center;border-radius:999px;background:#5966dd;color:#fff;font-size:10px}.tools-menu{position:relative}.tools-menu summary{display:grid;width:42px;height:42px;place-items:center;border:1px solid #dce1eb;border-radius:10px;background:#fff;color:#475467;cursor:pointer;font-size:16px;font-weight:900;list-style:none}.tools-menu summary::-webkit-details-marker{display:none}.tools-menu>div{position:absolute;z-index:30;top:48px;right:0;display:grid;width:210px;padding:6px;border:1px solid #dde2eb;border-radius:12px;background:#fff;box-shadow:0 16px 40px #10182826}.tools-menu button,.tools-menu a{display:block;width:100%;padding:10px 11px;border:0;border-radius:8px;background:transparent;box-shadow:none;color:#344054;text-align:left;text-decoration:none;font-size:11px;font-weight:700}.tools-menu button:hover,.tools-menu a:hover{background:#f2f4f7;transform:none}.workspace-bar{display:grid;grid-template-columns:minmax(280px,1fr) auto auto;gap:8px;align-items:stretch;margin:20px 0 14px;padding:7px;border:1px solid #dfe3eb;border-radius:15px;background:#fff;box-shadow:0 8px 22px #18213a08}.location-picker,.selection-step,.create-access{display:flex;align-items:center;gap:10px;min-width:0;padding:8px 11px;border-radius:10px}.location-picker>span,.selection-step>span,.create-access>span{display:grid;width:27px;height:27px;flex:none;place-items:center;border-radius:8px;background:#edf0f5;color:#667085;font-size:10px;font-weight:900}.location-picker>div{min-width:0}.workspace-bar small{display:block;margin-bottom:4px;color:#8a94a5;font-size:8px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.workspace-bar b{font-size:11px}.location-tabs{margin:0!important;gap:4px!important;flex-wrap:nowrap!important;overflow:auto}.location-tabs button{padding:5px 9px;border-radius:7px;font-size:10px;white-space:nowrap}.selection-step{min-width:155px;border-left:1px solid #edf0f4;color:#667085}.selection-step.ready{color:#27304a}.selection-step.ready>span{background:#e8ecff;color:#4c58d7}.create-access{border:0;background:linear-gradient(135deg,#4f5bd9,#6875f1);box-shadow:none;color:#fff;text-align:left}.create-access>span{background:#ffffff22;color:#fff}.create-access small{color:#dfe3ff}.create-access:disabled{background:#e8ebf1;color:#8c96a7}.create-access:disabled>span{background:#dce1e9;color:#8993a3}.create-access:disabled small{color:#98a2b3}.qr-backdrop,.shares-backdrop{position:fixed;z-index:1200;inset:0;display:grid;place-items:center;padding:20px;background:#101828a6;backdrop-filter:blur(7px)}.qr-card{position:relative;display:grid;width:min(450px,100%);place-items:center;padding:30px;border-radius:22px;background:#fff;box-shadow:0 30px 90px #0005;text-align:center}.qr-card h3{margin:0;font-size:22px}.qr-card p{margin:7px 0 18px;color:var(--muted);font-size:11px}.qr-image{display:grid;place-items:center;padding:12px;border:1px solid #e1e5ec;border-radius:16px;background:#fff;box-shadow:0 10px 24px #18213a12}.qr-card img{width:250px;max-width:100%;border-radius:8px}.qr-card>small{max-width:100%;margin:12px 0 17px;overflow-wrap:anywhere;color:var(--muted);font-size:9px}.qr-actions{display:grid!important;grid-template-columns:1fr 1fr;width:100%;gap:8px}.modal-close{display:grid!important;position:absolute;top:14px;right:14px;width:34px;height:34px;padding:0!important;place-items:center;border-radius:50%!important;background:#eef1f6!important;box-shadow:none!important;color:#475467!important;font-size:21px!important}.danger-link{margin-top:15px;padding:5px;background:transparent;box-shadow:none;color:#b42336;font-size:10px}.danger-link:hover{box-shadow:none!important}.shares-panel{display:flex;flex-direction:column;width:min(760px,100%);height:min(820px,calc(100vh - 32px));max-height:calc(100vh - 32px);overflow:hidden;border-radius:22px;background:#f8f9fc;box-shadow:0 30px 90px #0007}.shares-panel>header{position:relative;display:flex;flex:0 0 auto;justify-content:space-between;padding:24px 26px 18px;background:#fff;border-bottom:1px solid #e4e7ec}.shares-panel h3{margin:0;font-size:23px}.shares-panel header p{margin:5px 0 0;color:#7a8495;font-size:11px}.share-summary{display:grid;flex:0 0 auto;grid-template-columns:1fr 1fr;gap:9px;padding:13px 18px}.share-summary article{display:flex;align-items:baseline;gap:7px;padding:12px 14px;border:1px solid #e1e5eb;border-radius:11px;background:#fff}.share-summary b{font-size:21px}.share-summary span{color:#7c8798;font-size:10px}.share-list{display:grid;flex:1 1 auto;min-height:220px;align-content:start;gap:8px;overflow:auto;padding:0 18px 18px}.share-list-hint{margin:0;padding:9px 11px;border:1px solid #e1e5eb;border-radius:9px;background:#fff;color:#667085;font-size:10px}.share-row{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:12px;align-items:center;padding:14px;border:1px solid #e2e6ed;border-radius:13px;background:#fff}.share-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:11px;background:#e9f8f1;color:#087443;font-size:18px}.share-icon.revoked{background:#feecef;color:#b42336}.share-icon.expired{background:#f0f2f5;color:#7b8494}.share-main{min-width:0}.share-title{display:flex;align-items:center;gap:7px}.share-title>b{font-size:12px}.share-title>span{padding:3px 6px;border-radius:999px;background:#f0f2f5;color:#667085;font-size:8px;font-weight:900;text-transform:uppercase}.share-title>span.active{background:#dcfae6;color:#067647}.share-title>span.revoked{background:#fee4e2;color:#b42318}.share-main p{margin:5px 0;overflow:hidden;color:#475467;font-size:10px;text-overflow:ellipsis;white-space:nowrap}.share-main small{display:block;margin-top:3px;color:#8a94a5;font-size:8px}.revoke-button{padding:8px 10px;border:1px solid #f0c4ca;background:#fff;box-shadow:none;color:#b42336;font-size:9px;white-space:nowrap}.shares-empty{display:grid;min-height:220px;place-items:center;align-content:center;gap:5px;color:#8a94a5;text-align:center}.shares-empty b{color:#344054}.shares-empty span{font-size:10px}
    .camera-settings-link{margin:2px 0 6px!important}
    .header-actions,.location-tabs,.editor-bar,.plan-legend{display:flex;gap:10px;align-items:center}.secondary,.ghost,.location-tabs button{background:#eef1f6;color:#344054;box-shadow:none}.location-tabs button.active,.ghost.active{background:#4058df;color:white}.notice{padding:12px 14px;border-radius:8px;background:#ecfdf3;color:#067647}
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
    @media(max-width:1100px){.plan-layout{grid-template-columns:1fr}.camera-list{max-height:280px}}@media(max-width:900px){.workspace-bar{grid-template-columns:1fr 1fr}.location-picker{grid-column:1/-1}.zone-editor{grid-template-columns:1fr 1fr}.plan{min-height:420px}.plan-legend b{width:100%;margin:0}}@media(max-width:600px){main>section>header{align-items:flex-start;flex-direction:column}.header-actions{width:100%}.access-button{flex:1;justify-content:center}.workspace-bar{grid-template-columns:1fr}.location-picker{grid-column:auto;align-items:flex-start}.location-picker>div{width:100%}.location-tabs{display:flex;grid-template-columns:none;width:100%}.location-tabs button{width:auto;min-height:36px}.selection-step{border-top:1px solid #edf0f4;border-left:0}.create-access{min-height:52px}.editor-bar{align-items:stretch;flex-direction:column}.editor-bar button,.editor-bar .upload{justify-content:center;width:100%;min-height:42px}.background-control{align-items:stretch;flex-direction:column}.background-control input{width:100%}.zone-editor{grid-template-columns:1fr}.plan{min-height:360px;aspect-ratio:3/4}.camera-list{max-height:340px}.plan-legend{justify-content:flex-start}.plan-legend button{flex:1}.camera-info{align-items:flex-start;flex-direction:column;gap:10px}.shares-backdrop{align-items:end;padding:0}.shares-panel{max-height:92vh;border-radius:22px 22px 0 0}.share-summary{padding-inline:12px}.share-list{padding-inline:12px}.share-row{grid-template-columns:34px minmax(0,1fr);padding:12px}.share-icon{width:34px;height:34px}.revoke-button{grid-column:2;width:max-content}.qr-card{padding:25px 18px}.qr-actions{grid-template-columns:1fr!important}}
  `]
})
export class CamerasComponent implements OnDestroy{
  private http=inject(HttpClient);
  private socket?:Socket;
  @ViewChild("plan") planRef?:ElementRef<HTMLElement>;
  locations=signal<Location[]>([]);rooms=signal<Room[]>([]);cameras=signal<Camera[]>([]);locationId=signal("");zones=signal<Zone[]>([]);backgroundImage=signal<string|null>(null);backgroundMode=signal<BackgroundMode>("CONTAIN");backgroundScale=signal(100);backgroundX=signal(50);backgroundY=signal(50);
  aiStates=signal<Record<string,{peopleCount:number;occupied:boolean;motion:boolean}>>({});
  editing=signal(false);drawing=signal(false);saving=signal(false);syncing=signal(false);error=signal("");notice=signal("");selectedIds=signal<string[]>([]);
  activeControlCameraId=signal<string|null>(null);cameraControlError=signal("");private ptzMoving=false;
  renamingId=signal<string|null>(null);
  qrImage=signal("");qrUrl=signal("");qrShareId=signal("");qrCameraCount=signal(0);
  shares=signal<CameraShare[]>([]);sharesOpen=signal(false);sharesLoading=signal(false);revokingId=signal("");
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
    if(this.canManageCameras())this.loadShares();
    this.initSocket();
  }
  ngOnDestroy(){this.socket?.disconnect()}
  private initSocket(){
    this.fetchAiStates();
    try{
      const token=sessionStorage.getItem("access_token");
      if(token){
        // Nginx exposes Socket.IO at /socket.io. The old /ws path returned
        // the SPA HTML page with HTTP 200, so Socket.IO retried forever and
        // intermittently showed a misleading WebSocket error.
        this.socket=io({path:"/socket.io",transports:["websocket"],auth:{token}});
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
  selectLocation(id:string){this.stopPtz();this.activeControlCameraId.set(null);this.locationId.set(id);this.editing.set(false);this.http.get<Plan>(`/api/locations/${id}/plan`).subscribe({next:p=>{this.backgroundImage.set(p.backgroundImage);this.backgroundMode.set(p.backgroundMode||"CONTAIN");this.backgroundScale.set(+(p.backgroundScale||100));this.backgroundX.set(+(p.backgroundX??50));this.backgroundY.set(+(p.backgroundY??50));this.zones.set(p.zones.map(z=>({...z,x:+z.x,y:+z.y,width:+z.width,height:+z.height,roomId:z.room_id||""})));},error:()=>this.error.set("Не удалось загрузить план локации.")})}
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
  cameraClick(e:Event,c:Camera){e.stopPropagation();if(this.editing()||this.suppressClick){this.suppressClick=false;return}this.activateCameraControl(c);this.toggle(c)}
  listCameraClick(c:Camera){if(this.renamingId()!==c.id){this.activateCameraControl(c);this.toggle(c)}}
  rename(c:Camera,name:string){const value=name.trim();if(value.length<2){this.error.set("Название камеры должно содержать минимум 2 символа.");return}this.http.patch<Camera>(`/api/cameras/${c.id}/name`,{name:value}).subscribe({next:updated=>{this.cameras.update(items=>items.map(item=>item.id===c.id?{...item,name:updated.name}:item));this.renamingId.set(null);this.notice.set("Название камеры сохранено.")},error:()=>this.error.set("Не удалось переименовать камеру.")})}
  isSelected(id:string){return this.selectedIds().includes(id)} selectedCameras(){const ids=new Set(this.selectedIds());return this.locationCameras().filter(c=>ids.has(c.id))}
  activeControlCamera(){const id=this.activeControlCameraId();return id?this.cameras().find(camera=>camera.id===id):undefined}
  private activateCameraControl(camera:Camera){this.activeControlCameraId.set(camera.id);this.cameraControlError.set("")}
  startPtz(event:PointerEvent,direction:"UP"|"DOWN"|"LEFT"|"RIGHT"){event.preventDefault();event.stopPropagation();const camera=this.activeControlCamera();if(!camera)return;this.ptzMoving=true;this.sendPtz(camera,direction)}
  stopPtz(force=false){if(!this.ptzMoving&&!force)return;this.ptzMoving=false;const camera=this.activeControlCamera();if(camera)this.sendPtz(camera,"STOP")}
  private sendPtz(camera:Camera,direction:"UP"|"DOWN"|"LEFT"|"RIGHT"|"STOP"){this.cameraControlError.set("");this.http.post(`/api/cameras/${camera.id}/control`,{action:"ptz",direction}).subscribe({error:({error})=>this.cameraControlError.set(error?.message||"Команда не поддерживается этой камерой")})}
  @HostListener("document:keydown",["$event"]) keyDown(event:KeyboardEvent){const direction=({ArrowUp:"UP",ArrowRight:"RIGHT",ArrowDown:"DOWN",ArrowLeft:"LEFT"} as const)[event.key as "ArrowUp"|"ArrowRight"|"ArrowDown"|"ArrowLeft"];if(!direction||event.repeat||this.isEditingText(event.target))return;const camera=this.activeControlCamera();if(!camera)return;event.preventDefault();this.ptzMoving=true;this.sendPtz(camera,direction)}
  @HostListener("document:keyup",["$event"]) keyUp(event:KeyboardEvent){if(!event.key.startsWith("Arrow")||this.isEditingText(event.target))return;event.preventDefault();this.stopPtz()}
  @HostListener("window:blur") stopPtzOnBlur(){this.stopPtz()}
  private isEditingText(target:EventTarget|null){return target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement||(target instanceof HTMLElement&&target.isContentEditable)}
  toggle(c:Camera){if(this.isSelected(c.id))this.selectedIds.update(v=>v.filter(id=>id!==c.id));else this.selectedIds.update(v=>[...v,c.id]);this.persistSelection()}
  selectOnline(){for(const c of this.locationCameras().filter(c=>c.status==="ONLINE"&&!this.isSelected(c.id)))this.selectedIds.update(v=>[...v,c.id]);this.persistSelection()}clearSelection(){this.selectedIds.set([]);this.persistSelection()}
  private persistSelection(){localStorage.setItem("questcontrol.selectedCameras",JSON.stringify(this.selectedIds()));window.dispatchEvent(new Event("questcontrol-camera-selection"))}
  syncTuya(){this.syncing.set(true);this.http.post<any>("/api/cameras/sync/tuya",{}).subscribe({next:r=>{this.syncing.set(false);this.notice.set(`Tuya: камер ${r.cameras}, добавлено ${r.created}.`);this.loadCameras()},error:()=>{this.syncing.set(false);this.error.set("Не удалось синхронизировать Tuya.")}})}
  loadShares(){this.sharesLoading.set(true);this.http.get<CameraShare[]>("/api/camera-shares").subscribe({next:items=>{this.shares.set((Array.isArray(items)?items:[]).map(share=>({...share,camera_names:Array.isArray(share.camera_names)?share.camera_names.filter(name=>typeof name==="string"):[]})));this.sharesLoading.set(false)},error:()=>{this.sharesLoading.set(false);this.error.set("Не удалось загрузить список QR-доступов.")}})}
  openShares(){this.sharesOpen.set(true);this.loadShares()}
  activeShareCount(){return this.shares().filter(share=>share.active).length}
  shareCameraNames(share:CameraShare){return share.camera_names.length?share.camera_names.join(" · "):"Камеры удалены"}
  shareStatus(share:CameraShare){return share.revoked_at?"Отозван":share.active?"Активен":"Истёк"}
  cameraWord(count:number){const last=count%10,lastTwo=count%100;return last===1&&lastTwo!==11?"камера":last>=2&&last<=4&&(lastTwo<12||lastTwo>14)?"камеры":"камер"}
  createParentQr(){const allowed=new Set(this.cameras().map(camera=>camera.id));const cameraIds=this.selectedIds().filter(id=>allowed.has(id));if(!cameraIds.length)return;this.http.post<{id:string;token:string}>("/api/camera-shares",{cameraIds,expiresInHours:24}).subscribe({next:async share=>{const url=`${location.origin}/watch/${share.token}`;this.qrShareId.set(share.id);this.qrUrl.set(url);this.qrCameraCount.set(cameraIds.length);this.qrImage.set(await QRCode.toDataURL(url,{width:520,margin:2,errorCorrectionLevel:"M"}));this.loadShares()},error:()=>this.error.set("Не удалось создать QR-код доступа.")})}
  revokeShare(share:CameraShare){if(!share.active||this.revokingId())return;this.revokingId.set(share.id);this.http.delete(`/api/camera-shares/${share.id}`).subscribe({next:()=>{this.revokingId.set("");this.notice.set("Доступ отозван. Ссылка больше не откроет камеры.");this.loadShares()},error:()=>{this.revokingId.set("");this.error.set("Не удалось отозвать доступ.")}})}
  revokeQr(){const id=this.qrShareId();if(!id)return;this.http.delete(`/api/camera-shares/${id}`).subscribe({next:()=>{this.closeQr();this.notice.set("Доступ по QR-коду отозван.");this.loadShares()},error:()=>this.error.set("Не удалось отозвать доступ.")})}
  async copyQrLink(){try{await navigator.clipboard.writeText(this.qrUrl());this.notice.set("Ссылка скопирована.")}catch{this.error.set("Не удалось скопировать ссылку.")}}
  downloadQr(){const link=document.createElement("a");link.href=this.qrImage();link.download=`questcontrol-camera-access-${new Date().toISOString().slice(0,10)}.png`;link.click()}
  closeTools(event:Event){const details=(event.currentTarget as HTMLElement).closest("details");if(details)details.removeAttribute("open")}
  closeQr(){this.qrImage.set("");this.qrUrl.set("");this.qrShareId.set("");this.qrCameraCount.set(0)}
}
