import { Component, HostListener, inject, OnDestroy, signal } from "@angular/core";
import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { RouterLink } from "@angular/router";
import { DatePipe } from "@angular/common";
import { DomSanitizer, SafeResourceUrl } from "@angular/platform-browser";
import { FormsModule } from "@angular/forms";
import { Subscription, catchError, forkJoin, interval, of, startWith, switchMap } from "rxjs";
import { io, Socket } from "socket.io-client";
import { HlsPlayerComponent } from "../cameras/hls-player.component";
import { WebRtcPlayerComponent } from "../cameras/webrtc-player.component";

type Room = { id:string; name:string; location_name?:string };
type KrampusStatus = {
  serial?: { enabled?:boolean; path?:string };
  game?: { state?:string };
  uptime?:number;
  [key:string]:unknown;
};
type LogLine = { at?:string; direction?:string; line?:string };
type VoiceHint = { id:string; name:string; file_name:string; content_type:string; size_bytes:number; created_at:string };
type DoorbellCall = { id:string; camera_id:string; camera_name:string; camera_status:string; status:"RINGING"|"ACKNOWLEDGED"|"EXPIRED"; rang_at:string; acknowledged_at:string|null };
type HelpCamera = { id:string; name:string; provider:string; status:string; config?:{category?:string} };
type HelpButtonConfig = { cameraId:string|null; cameras:HelpCamera[] };
type RoomCamera = { id:string; name:string; provider:string; status:string; room_id?:string|null; room_name?:string|null };
type CameraPlayer = { mode:"hls"|"player"|"webrtc"; endpoint?:string; safeEndpoint?:SafeResourceUrl };
type Game = { id:string; name:string; room_id:string };
type GameSession = { id:string; room_id:string; game_id:string|null; status:"RUNNING"|"PAUSED"|"FINISHED"|"CANCELLED"; started_at:string|null; ended_at:string|null; remaining_seconds:number|null };
type PollResult<T> = { ok:true; value:T } | { ok:false };

const ATMOSPHERE = ["LIGHT UV","LIGHT WHITE","LIGHT OK","LIGHT OFF","LIGHT RESET","MASK SOUND"] as const;
const MECHANISMS = ["PUZZLE SOLVE","PUZZLE RESET","BEAR SOUND","BEAR OPEN","BEAR CLOSE","DOOR OPEN","DOOR CLOSE","TABLE OPEN","TABLE CLOSE","TABLE LEG OPEN","TABLE LEG CLOSE"] as const;
const OVEN = ["OVEN SOLVED","OVEN RESET","OVEN UV ON","OVEN UV OFF","OVEN LIGHT ON","OVEN LIGHT OFF","OVEN MOVE ON","OVEN MOVE OFF","OVEN FOG ON","OVEN FOG OFF"] as const;
type ToggleKey="bear"|"door"|"table"|"tableLeg"|"ovenUv"|"ovenLight"|"ovenMove"|"ovenFog";

@Component({
  selector:"app-krampus", standalone:true, imports:[RouterLink,DatePipe,FormsModule,HlsPlayerComponent,WebRtcPlayerComponent],
  template:`
  <main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="sessions-nav" routerLink="/sessions">Сессии</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/inventory">Инвентарь</a><a routerLink="/users">Пользователи</a></nav></aside>
  <section>
    <header><div><h2>Krampus House</h2></div>
      <div class="connections"><span class="connection" [class.online]="agentOnline()">{{agentOnline()?"Agent online":"Agent offline"}}</span><span class="connection" [class.online]="arduinoOnline()">{{arduinoOnline()?"Arduino online":"Arduino offline"}}</span></div>
    </header>
    @if(error()){<p class="error">{{error()}} <button class="inline" (click)="loadRoom()">Повторить</button></p>}
    @if(notice()){<p class="notice">{{notice()}}</p>}
    @if(activeDoorbellCall();as call){
      <article class="help-call" role="alert" aria-live="assertive">
        <div class="help-call-copy">
          <span class="help-pulse">!</span>
          <div><small>ВЫЗОВ С DOORBELL</small><h3>Запрошена помощь</h3><p>{{call.camera_name}} · {{call.rang_at|date:'HH:mm:ss'}}</p></div>
        </div>
        <div class="help-call-actions">
          <button class="camera-button" (click)="openDoorbellVideo(call)" [disabled]="doorbellVideoLoading()">{{doorbellVideoLoading()?"Подключение…":doorbellStream()?"Обновить видео":"Показать камеру"}}</button>
          <button class="ack-button" (click)="acknowledgeDoorbell(call)">Вызов принят</button>
        </div>
        @if(doorbellStream()){
          <div class="doorbell-video"><app-hls-player [url]="doorbellStream()"></app-hls-player></div>
        } @else if(doorbellVideoError()){
          <p class="doorbell-video-error">{{doorbellVideoError()}}</p>
        }
      </article>
    }
    @if(loading()){<div class="empty"><b>Подключение к Krampus…</b><span>Ищем комнату и room-agent.</span></div>}
    @else if(!roomId()){<div class="empty"><b>Комната Krampus не настроена</b><span>Создайте комнату с «Krampus» в названии и привяжите устройство с agent_id.</span></div>}
    @else{<div class="krampus-workspace"><div class="control-pane">
      <article class="session-timer" [class.running]="activeSession()?.status==='RUNNING'">
        <div><span>ИГРОВАЯ СЕССИЯ</span><b>{{activeSession()?'Таймер запущен':'Новая игра'}}</b><small>{{activeSession()?roomName():'Запуск синхронизируется на всех устройствах'}}</small></div>
        <strong>{{timerText()}}</strong>
        @if(activeSession()){<button class="finish-session" [disabled]="sessionBusy()" (click)="finishSession()">{{sessionBusy()?'Завершаем…':'Завершить'}}</button>}
        @else{<label><span>Минут</span><input type="number" min="5" max="240" step="5" [ngModel]="sessionMinutes()" (ngModelChange)="sessionMinutes.set(+$event)"></label><button class="start-session" [disabled]="sessionBusy()" (click)="startSession()">{{sessionBusy()?'Запускаем…':'▶ Запустить таймер'}}</button>}
      </article>
      <div class="krampus-actions"><button class="start" [disabled]="busy()" (click)="command('START')">START</button><button [disabled]="busy()" (click)="command('STATUS')">STATUS</button><button class="danger-solid" [disabled]="busy()" (click)="command('RESET',true)">RESET</button><button class="danger-solid" [disabled]="busy()" (click)="command('ESTOP',true)">ESTOP</button></div>
      <div class="krampus-layout">
        <article class="control-card">
          <h3>Свет и атмосфера</h3>
          <div class="control-section"><span class="section-label">Режим света</span><div class="button-grid"><button [disabled]="busy()" (click)="command('LIGHT UV')">UV</button><button [disabled]="busy()" (click)="command('LIGHT WHITE')">Белый</button><button [disabled]="busy()" (click)="command('LIGHT OK')">Игровой</button><button [disabled]="busy()" (click)="command('LIGHT OFF')">Выключить</button></div></div>
          <div class="control-section"><span class="section-label">Разовые действия</span><div class="button-grid"><button [disabled]="busy()" (click)="command('MASK SOUND')">Звук маски</button><button class="secondary-danger" [disabled]="busy()" (click)="command('LIGHT RESET',true)">Сброс света</button></div></div>
        </article>
        <article class="control-card">
          <h3>Механизмы</h3>
          <div class="switch-list">
            <div class="switch-row"><span><b>Медведь</b><small>{{toggleText('bear','Закрыт','Открыт')}}</small></span><button class="switch" role="switch" [class.on]="toggleOn('bear')" [attr.aria-checked]="toggleOn('bear')" [disabled]="busy()" (click)="toggle('bear','BEAR OPEN','BEAR CLOSE')"><i></i></button></div>
            <div class="switch-row"><span><b>Дверь</b><small>{{toggleText('door','Закрыта','Открыта')}}</small></span><button class="switch" role="switch" [class.on]="toggleOn('door')" [attr.aria-checked]="toggleOn('door')" [disabled]="busy()" (click)="toggle('door','DOOR OPEN','DOOR CLOSE')"><i></i></button></div>
            <div class="switch-row"><span><b>Стол</b><small>{{toggleText('table','Закрыт','Открыт')}}</small></span><button class="switch" role="switch" [class.on]="toggleOn('table')" [attr.aria-checked]="toggleOn('table')" [disabled]="busy()" (click)="toggle('table','TABLE OPEN','TABLE CLOSE')"><i></i></button></div>
            <div class="switch-row"><span><b>Ножка стола</b><small>{{toggleText('tableLeg','Магнит включён · светодиод выключен','Магнит выключен · светодиод включён')}}</small></span><button class="switch" role="switch" [class.on]="toggleOn('tableLeg')" [attr.aria-checked]="toggleOn('tableLeg')" [disabled]="busy()" (click)="toggle('tableLeg','TABLE LEG OPEN','TABLE LEG CLOSE')"><i></i></button></div>
          </div>
          <div class="control-section"><span class="section-label">Пятнашки</span><div class="button-grid"><button [disabled]="busy()" (click)="command('PUZZLE SOLVE')">Решить пятнашки</button><button class="secondary-danger" [disabled]="busy()" (click)="command('PUZZLE RESET',true)">Сбросить пятнашки</button></div></div>
          <div class="control-section"><span class="section-label">Звук</span><div class="button-grid"><button [disabled]="busy()" (click)="command('BEAR SOUND')">Звук медведя</button></div></div>
        </article>
        <article class="control-card">
          <h3>Печка</h3>
          <div class="switch-list">
            <div class="switch-row"><span><b>Печка решена</b><small>{{toggleText('ovenUv','Не решена','Решена')}}</small></span><button class="switch" role="switch" [class.on]="toggleOn('ovenUv')" [attr.aria-checked]="toggleOn('ovenUv')" [disabled]="busy()" (click)="toggle('ovenUv','OVEN UV ON','OVEN UV OFF')"><i></i></button></div>
            <div class="switch-row"><span><b>Движение печки</b><small>{{toggleText('ovenMove')}}</small></span><button class="switch" role="switch" [class.on]="toggleOn('ovenMove')" [attr.aria-checked]="toggleOn('ovenMove')" [disabled]="busy()" (click)="toggle('ovenMove','OVEN MOVE ON','OVEN MOVE OFF')"><i></i></button></div>
          </div>
        </article>
        <article class="control-card"><h3>Звуки</h3><div class="button-grid"><button [disabled]="busy()" (click)="sound('play','alert.mp3')">ALERT</button><button [disabled]="busy()" (click)="sound('play','calling.mp3')">CALLING</button><button class="danger-solid" [disabled]="busy()" (click)="sound('stop')">STOP</button></div>
          <div class="voice-hints">
            <h4>Голосовые подсказки</h4>
            <p>Загрузите готовую запись и отправляйте её игрокам одним нажатием.</p>
            <div class="hint-upload">
              <label>Название<input maxlength="120" placeholder="Например: Посмотрите под столом" [ngModel]="hintName()" (ngModelChange)="hintName.set($event)"></label>
              <label class="file-picker">🎵 {{hintFileName()||"Выбрать аудиофайл"}}<input type="file" accept=".mp3,.wav,.ogg,.webm,.m4a,audio/mpeg,audio/wav,audio/ogg,audio/webm,audio/mp4" (change)="selectHintFile($event)"></label>
              <button [disabled]="busy()||!hintName().trim()||!hintFile()" (click)="uploadHint()">Добавить</button>
            </div>
            <div class="hint-list">
              @for(hint of voiceHints();track hint.id){
                <div class="hint-row">
                  <span><b>{{hint.name}}</b><small>{{hint.file_name}} · {{fileSize(hint.size_bytes)}}</small></span>
                  <div>
                    <button class="hint-preview" title="Прослушать на этом компьютере" [disabled]="busy()" (click)="previewHint(hint)">▶</button>
                    <button class="hint-send" [disabled]="busy()||!agentOnline()" (click)="playHint(hint)">Отправить</button>
                    <button class="hint-delete" title="Удалить" [disabled]="busy()" (click)="deleteHint(hint)">×</button>
                  </div>
                </div>
              } @empty {<div class="no-hints">Сохранённых подсказок пока нет.</div>}
            </div>
          </div>
        </article>
      </div>
      <h3>Датчики</h3><div class="sensor-grid">@for(item of sensorEntries();track item[0]){<article><span>{{sensorLabel(item[0])}}</span><b [class.active]="sensorActive(item[1])">{{sensorValue(item[1])}}</b></article>}@empty{<div class="empty compact">Нет данных от датчиков</div>}</div>
      <h3>Serial-консоль</h3><div class="terminal">@for(line of logLines();track $index){<div><time>{{logTime(line)}}</time><b>{{line.direction||"—"}}</b><code>{{line.line||""}}</code></div>}@empty{<span>Нет данных</span>}</div>
      <div class="service-settings">
        <article class="serial-settings">
          <div><span>ARDUINO SERIAL</span><h3>Порт подключения</h3><p>Для клонов чаще всего используется <code>/dev/ttyUSB0</code>, для оригинальных плат — <code>/dev/ttyACM0</code>.</p></div>
          <label><span>Путь устройства</span><input list="serial-ports" [ngModel]="serialPort()" (ngModelChange)="serialPort.set($event)" placeholder="/dev/ttyUSB0" autocomplete="off"><datalist id="serial-ports"><option value="/dev/ttyUSB0"><option value="/dev/ttyUSB1"><option value="/dev/ttyACM0"><option value="/dev/ttyACM1"></datalist></label>
          <button [disabled]="savingSerial()||!serialPort().trim()" (click)="saveSerialPort()">{{savingSerial()?"Подключение…":"Применить порт"}}</button>
        </article>
        <article class="help-button-settings">
          <div><span>КНОПКА ПОМОЩИ</span><h3>Источник вызова</h3><p>Выберите устройство, нажатие которого должно показывать вызов в этой панели.</p></div>
          <select [ngModel]="helpCameraId()" (ngModelChange)="helpCameraId.set($event)">
            @for(camera of helpCameras();track camera.id){<option [value]="camera.id">{{camera.name}} · {{camera.status}}</option>}
          </select>
          <button [disabled]="savingHelpCamera()||!helpCameraId()" (click)="saveHelpCamera()">{{savingHelpCamera()?"Сохранение…":"Сохранить"}}</button>
        </article>
      </div>
      </div><aside class="camera-pane" [class.focused]="focusedCameraId()">
        <div class="camera-heading"><div><span>НАБЛЮДЕНИЕ</span><h3>Камеры комнаты</h3></div><div class="camera-heading-actions">@if(focusedCameraId()){<button (click)="focusedCameraId.set(null)">Показать все</button>}<button class="camera-talk" [class.recording]="recording()" [disabled]="busy()||!agentOnline()" [title]="recording()?'Говорите — отпустите для завершения':'Удерживайте, чтобы говорить в комнате'" (pointerdown)="startTalking($event)" (pointerup)="stopTalking()" (pointercancel)="stopTalking()" (pointerleave)="stopTalking()" (keydown.space)="startTalking($event)" (keyup.space)="stopTalking()"><span>🎙</span>{{recording()?"Говорите…":"Говорить"}}</button></div></div>
        @if(camerasLoading()){<div class="camera-empty">Подключаем камеры…</div>}
        @else if(!roomCameras().length){<div class="camera-empty"><b>Камеры не выбраны</b><span>Выберите нужные ракурсы на странице «Камеры» — здесь появятся только они.</span><a routerLink="/cameras">Выбрать камеры</a></div>}
        @else{<div class="camera-grid" [class.single]="focusedCameraId()" [class.count-1]="!focusedCameraId()&&visibleCameras().length===1" [class.count-2]="!focusedCameraId()&&visibleCameras().length===2" [class.count-3]="!focusedCameraId()&&visibleCameras().length===3" [class.count-4]="!focusedCameraId()&&visibleCameras().length>=4">
          @for(camera of visibleCameras();track camera.id){<article class="camera-tile" [class.active-camera]="activeCameraId()===camera.id" (click)="selectCamera(camera)">
            <div class="camera-video">
              @if(cameraPlayers()[camera.id];as player){
                @if(player.mode==="webrtc"){<app-webrtc-player [cameraId]="camera.id" (fallbackRequested)="fallbackCamera(camera)"/>}
                @else if(player.mode==="hls"){<app-hls-player [url]="player.endpoint!"/>}
                @else{<iframe [src]="player.safeEndpoint!" [title]="camera.name" allow="autoplay; fullscreen"></iframe>}
              } @else {<button (click)="openCamera(camera);$event.stopPropagation()">▶ Открыть камеру</button>}
              <span class="camera-status" [class.online]="camera.status==='ONLINE'">{{camera.status==='ONLINE'?'ONLINE':camera.status}}</span>
            </div>
            <footer><span><b>{{camera.name}}</b><small>{{camera.provider}}{{camera.provider==='TUYA'&&activeCameraId()===camera.id?' · активна для PTZ':''}}</small></span><button (click)="focusCamera(camera.id);$event.stopPropagation()" [attr.aria-label]="focusedCameraId()?'Вернуться к сетке':'Развернуть камеру'">{{focusedCameraId()?'↙':'↗'}}</button></footer>
            @if(cameraControlErrors()[camera.id]){<p class="camera-control-error">{{cameraControlErrors()[camera.id]}}</p>}
          </article>}
        </div>}
      </aside></div>
    }
  </section></main>`,
  styles:[`
  .connections{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px}.connection{padding:8px 12px;border-radius:20px;background:#feecef;color:#ad2436}.connection.online{background:#e4f7ed;color:#137344}.notice{padding:12px 14px;border-radius:8px;background:#ecfdf3;color:#067647}.inline{padding:4px 8px;margin-left:8px;background:transparent;color:inherit;border:1px solid currentColor;box-shadow:none}
  .help-call{display:grid;grid-template-columns:1fr auto;gap:18px;margin:20px 0;padding:20px;border:2px solid #e43d50;border-radius:14px;background:linear-gradient(135deg,#fff1f2,#fff);box-shadow:0 12px 35px #b4231830}.help-call-copy{display:flex;align-items:center;gap:14px}.help-call-copy small{color:#b42318;font-size:10px;font-weight:900;letter-spacing:.12em}.help-call-copy h3{margin:3px 0;color:#8f1d2c;font-size:25px}.help-call-copy p{margin:0;color:#7a3440}.help-pulse{display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:#d92d42;color:#fff;font-size:30px;font-weight:900;animation:help-pulse 1.2s infinite}.help-call-actions{display:flex;align-items:center;gap:8px}.help-call-actions button{white-space:nowrap}.camera-button{background:#273248}.ack-button{background:#168653}.doorbell-video{grid-column:1/-1;height:min(56vw,520px);overflow:hidden;border-radius:10px;background:#101622}.doorbell-video-error{grid-column:1/-1;margin:0;padding:12px 14px;border-radius:8px;background:#fff;color:#9f2534}@keyframes help-pulse{50%{box-shadow:0 0 0 12px #d92d4218}}
  .summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:24px 0}.summary div{display:grid;gap:5px;padding:14px;background:#fff;border:1px solid #e1e5ed;border-radius:10px}.summary span{color:#6b7280;font-size:12px}.summary b{overflow:hidden;text-overflow:ellipsis}
  .session-timer{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:14px;align-items:center;margin:0 0 16px;padding:16px 18px;border:1px solid #d8deea;border-radius:12px;background:#fff}.session-timer.running{border-color:#98d9b9;background:#f2fbf6}.session-timer>div span,.session-timer>div b,.session-timer>div small{display:block}.session-timer>div span{color:#526078;font-size:9px;font-weight:900;letter-spacing:.1em}.session-timer>div b{margin-top:4px}.session-timer>div small{margin-top:3px;color:#7a8495;font-size:10px}.session-timer>strong{font-size:30px;font-variant-numeric:tabular-nums}.session-timer label{display:grid;grid-template-columns:auto 72px;align-items:center;gap:7px;color:#667085;font-size:10px}.session-timer input{width:72px;padding:9px}.session-timer button{white-space:nowrap}.start-session{background:#168653}.finish-session{background:#bd3042}
  .help-button-settings,.serial-settings{display:grid;grid-template-columns:minmax(260px,1fr) minmax(240px,360px) auto;gap:12px;align-items:center;margin:0 0 18px;padding:16px 18px;border:1px solid #d8deea;border-radius:11px;background:#fff}.help-button-settings span,.serial-settings span{color:#526078;font-size:10px;font-weight:900;letter-spacing:.1em}.help-button-settings h3,.serial-settings h3{margin:3px 0;font-size:17px}.help-button-settings p,.serial-settings p{margin:0;color:#7a8495;font-size:11px}.help-button-settings select,.serial-settings input{width:100%;padding:11px;border:1px solid #cfd6e2;border-radius:8px;background:#fff}.serial-settings label{display:grid;gap:6px}.serial-settings code{font-size:11px}.help-button-settings button,.serial-settings button{background:#4058df}
  .krampus-actions{display:flex;gap:10px;margin:0 0 24px}.krampus-actions button{min-width:110px}.start{background:#168653}.danger-solid{background:#bd3042!important}
  .krampus-layout{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.control-card{background:white;border:1px solid #e1e5ed;border-radius:11px;padding:18px}.control-card h3{margin-top:0}
  .button-grid{display:flex;flex-wrap:wrap;gap:8px}.button-grid button{background:#eef1f6;color:#273248;box-shadow:none}
  .control-section{margin-top:18px}.section-label{display:block;margin-bottom:9px;color:#6b7280;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.secondary-danger{background:#fff0f1!important;color:#a82030!important}
  .switch-list{display:grid;gap:2px}.switch-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid #eef0f4}.switch-row:last-child{border-bottom:0}.switch-row span,.switch-row b,.switch-row small{display:block}.switch-row small{margin-top:3px;color:#7a8495;font-size:11px}.switch{position:relative;flex:0 0 48px;width:48px;height:27px;padding:0;border-radius:20px;background:#cbd1dc;box-shadow:none}.switch i{position:absolute;left:3px;top:3px;width:21px;height:21px;border-radius:50%;background:#fff;box-shadow:0 2px 5px #10182735;transition:left .18s}.switch.on{background:#168653}.switch.on i{left:24px}.switch:hover:not(:disabled){transform:none;box-shadow:none}
  .voice-hints{margin-top:20px;padding-top:16px;border-top:1px solid #e1e5ed}.voice-hints h4{margin:0}.voice-hints>p{margin:7px 0 12px;color:#6b7280;font-size:12px}.hint-upload{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:end}.hint-upload label:first-child{grid-column:1/-1}.file-picker{display:flex;align-items:center;min-height:40px;padding:9px 11px;border:1px dashed #c7ceda;border-radius:8px;color:#4c5668;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-picker input{display:none}.hint-list{display:grid;gap:7px;margin-top:12px}.hint-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0;border-top:1px solid #eef0f4}.hint-row>span,.hint-row b,.hint-row small{display:block;min-width:0}.hint-row>span{overflow:hidden}.hint-row b,.hint-row small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hint-row small{margin-top:3px;color:#7a8495;font-size:10px}.hint-row>div{display:flex;gap:5px}.hint-row button{padding:7px 9px;box-shadow:none}.hint-preview{background:#eef1f6;color:#273248}.hint-send{background:#168653}.hint-delete{background:#fff0f1;color:#a82030}.no-hints{padding:12px 0;color:#7a8495;font-size:12px}
  .sensor-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.sensor-grid article{display:flex;justify-content:space-between;background:white;padding:12px;border:1px solid #e1e5ed;border-radius:8px}.sensor-grid b{color:#b32d3e}.sensor-grid b.active{color:#168653}.empty.compact{padding:24px;margin:0}
  .terminal{height:280px;overflow:auto;background:#101622;color:#d8dfec;border-radius:10px;padding:14px}.terminal div{display:grid;grid-template-columns:70px 55px 1fr;gap:8px;padding:3px}.terminal time{color:#78859d}.terminal b{color:#7c8cff}.terminal code{white-space:pre-wrap;overflow-wrap:anywhere}
  .service-settings{display:grid;gap:12px;margin-top:26px;padding-top:22px;border-top:1px solid #dfe3eb}.service-settings .serial-settings,.service-settings .help-button-settings{margin:0}
  .krampus-workspace{display:grid;grid-template-columns:minmax(420px,44%) minmax(0,1fr);gap:18px;align-items:start}.control-pane{min-width:0}.camera-pane{position:sticky;top:24px;display:flex;flex-direction:column;min-width:0;height:calc(100vh - 48px);padding:14px;border-radius:14px;background:#0d121b;color:#eef2f7;overflow:hidden}.camera-heading{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px}.camera-heading span{color:#8c98aa;font-size:9px;font-weight:900;letter-spacing:.12em}.camera-heading h3{margin:3px 0 0}.camera-heading button{padding:8px 10px;background:#273248;box-shadow:none}.camera-grid{display:grid;flex:1;grid-template-columns:1fr;grid-auto-rows:minmax(0,1fr);min-height:0;gap:9px}.camera-grid.single,.camera-grid.count-1,.camera-grid.count-2{grid-template-columns:1fr}.camera-grid.count-3,.camera-grid.count-4{grid-template-columns:repeat(2,minmax(0,1fr))}.camera-grid.count-3 .camera-tile:first-child{grid-column:1/-1}.camera-tile{display:flex;min-width:0;min-height:0;overflow:hidden;flex-direction:column;border:1px solid #293347;border-radius:10px;background:#151c28;cursor:pointer}.camera-tile.active-camera{border-color:#7183ff;box-shadow:0 0 0 1px #7183ff inset}.camera-video{position:relative;display:grid;flex:1;min-height:0;place-items:center;overflow:hidden;background:#020305}.camera-video app-webrtc-player,.camera-video app-hls-player,.camera-video iframe{display:block;width:100%;height:100%;border:0}.camera-video>button{background:#273248;color:#fff;box-shadow:none}.camera-status{position:absolute;top:8px;left:8px;padding:4px 6px;border-radius:5px;background:#3b2530;color:#ffbec6;font-size:8px;font-weight:900}.camera-status.online{background:#153c2b;color:#7ee2a8}.camera-tile footer{display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px}.camera-tile footer span,.camera-tile footer b,.camera-tile footer small{display:block;min-width:0}.camera-tile footer span{overflow:hidden}.camera-tile footer b,.camera-tile footer small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.camera-tile footer small{margin-top:2px;color:#8c98aa;font-size:9px}.camera-tile footer button{display:grid;flex:0 0 30px;width:30px;height:30px;padding:0;place-items:center;background:#273248;box-shadow:none}.camera-empty{display:grid;flex:1;min-height:280px;place-content:center;gap:5px;padding:20px;color:#8c98aa;text-align:center}.camera-empty b{color:#eef2f7}.camera-control-error{margin:0;padding:0 10px 10px;color:#ff9ca8;font-size:10px;text-align:center}
  .camera-heading-actions{display:flex;align-items:center;gap:8px}.camera-heading .camera-talk{display:flex;align-items:center;gap:7px;min-height:44px;padding:9px 14px;touch-action:none;user-select:none;background:#4058df}.camera-heading .camera-talk span{color:inherit;font-size:17px;line-height:1;letter-spacing:0}.camera-heading .camera-talk.recording{background:#bd3042;box-shadow:0 0 0 4px #bd304235}
  .krampus-workspace .summary{grid-template-columns:repeat(2,minmax(0,1fr))}.krampus-workspace .help-button-settings,.krampus-workspace .serial-settings{grid-template-columns:1fr}.krampus-workspace .help-button-settings button,.krampus-workspace .serial-settings button{width:100%}.krampus-workspace .krampus-layout{grid-template-columns:1fr}
  @media(max-width:1180px){.krampus-workspace{grid-template-columns:minmax(360px,43%) minmax(0,1fr)}}
  @media(max-width:900px){.krampus-workspace{grid-template-columns:1fr}.camera-pane{position:relative;top:auto;height:70vh;min-height:420px;grid-row:1}}
  @media(max-width:900px){.krampus-layout{grid-template-columns:1fr}.summary{grid-template-columns:1fr 1fr}.krampus-actions{flex-wrap:wrap}}
  @media(max-width:800px){.help-button-settings,.serial-settings{grid-template-columns:1fr}.help-button-settings button,.serial-settings button{width:100%}}
  @media(max-width:700px){.help-call{grid-template-columns:1fr}.help-call-actions{align-items:stretch;flex-direction:column}.doorbell-video{height:62vw}}
  @media(max-width:600px){.summary{grid-template-columns:1fr}.session-timer{grid-template-columns:1fr auto}.session-timer>div{grid-column:1/-1}.session-timer label{justify-self:start}.connections{justify-content:flex-start}.krampus-actions{display:grid;grid-template-columns:1fr 1fr}.krampus-actions button{width:100%;min-width:0;min-height:48px}.button-grid{display:grid;grid-template-columns:1fr 1fr}.button-grid button{min-height:44px}.hint-upload{grid-template-columns:1fr}.hint-row{align-items:stretch;flex-direction:column}.hint-row>div{display:grid;grid-template-columns:repeat(3,1fr)}.terminal div{grid-template-columns:50px 38px minmax(0,1fr);gap:5px}.control-card{padding:15px}}
  `]
})
export class KrampusComponent implements OnDestroy {
  private http=inject(HttpClient);
  private sanitizer=inject(DomSanitizer);
  private poll?:Subscription;
  roomId=signal(""); roomName=signal(""); status=signal<KrampusStatus|null>(null);
  sensors=signal<Record<string,unknown>>({}); logLines=signal<LogLine[]>([]);
  error=signal(""); notice=signal(""); loading=signal(true); busy=signal(false);
  agentOnline=signal(false); lastUpdated=signal<Date|null>(null);
  recording=signal(false); voiceStatus=signal("Нажмите и удерживайте кнопку, чтобы говорить в комнате.");
  voiceHints=signal<VoiceHint[]>([]); hintName=signal(""); hintFile=signal<File|null>(null); hintFileName=signal("");
  doorbellCalls=signal<DoorbellCall[]>([]); doorbellStream=signal(""); doorbellVideoError=signal(""); doorbellVideoLoading=signal(false);
  helpCameras=signal<HelpCamera[]>([]); helpCameraId=signal(""); savingHelpCamera=signal(false);
  serialPort=signal("/dev/ttyUSB0"); savingSerial=signal(false);
  roomCameras=signal<RoomCamera[]>([]); cameraPlayers=signal<Record<string,CameraPlayer>>({}); camerasLoading=signal(false); focusedCameraId=signal<string|null>(null);
  activeCameraId=signal<string|null>(null); cameraControlErrors=signal<Record<string,string>>({}); private activePtz=new Set<string>();
  activeSession=signal<GameSession|null>(null); roomGameId=signal<string|null>(null); sessionMinutes=signal(60); sessionBusy=signal(false); now=signal(Date.now());
  readonly atmosphere=ATMOSPHERE; readonly mechanisms=MECHANISMS; readonly oven=OVEN;
  toggleStates=signal<Partial<Record<ToggleKey,boolean>>>({});
  private voiceSocket?:Socket;
  private doorbellSocket?:Socket;
  private recorder?:MediaRecorder;
  private microphone?:MediaStream;
  private lastDoorbellId="";
  private clockTimer?:ReturnType<typeof setInterval>;

  constructor(){ this.loadRoom(); this.clockTimer=setInterval(()=>this.now.set(Date.now()),1000); }

  loadRoom(){
    this.poll?.unsubscribe(); this.loading.set(true); this.error.set("");
    this.http.get<Room[]>("/api/rooms").subscribe({
      next:rooms=>{
        const room=rooms.find(r=>/krampus/i.test(r.name));
        this.loading.set(false);
        if(!room){ this.roomId.set(""); return; }
        this.roomId.set(room.id); this.roomName.set(room.location_name?`${room.name} · ${room.location_name}`:room.name); this.loadHints(); this.loadHelpButton(); this.loadRoomCameras(); this.loadRoomGame(); this.connectDoorbell(); this.startPolling();
      },
      error:error=>{ this.loading.set(false); this.error.set(this.message(error,"Не удалось загрузить комнаты.")); }
    });
  }
  loadRoomCameras(){
    this.camerasLoading.set(true);
    this.http.get<RoomCamera[]>("/api/cameras").subscribe({
      next:cameras=>{
        const roomName=this.roomName().split(" · ")[0];
        let selectedIds:string[]=[];
        try{const stored=JSON.parse(localStorage.getItem("questcontrol.selectedCameras")||"[]");selectedIds=Array.isArray(stored)?stored:[];}catch{}
        const selected=new Set(selectedIds);
        const matches=cameras.filter(camera=>selected.has(camera.id)&&(camera.room_id===this.roomId()||camera.room_name===roomName||/krampus/i.test(camera.room_name||"")));
        this.roomCameras.set(matches); this.camerasLoading.set(false);
        if(!matches.some(camera=>camera.id===this.activeCameraId())) this.activeCameraId.set(matches.find(camera=>camera.provider==="TUYA")?.id||matches[0]?.id||null);
        for(const camera of matches) this.openCamera(camera);
      },
      error:()=>{ this.camerasLoading.set(false); this.error.set("Не удалось загрузить камеры комнаты."); }
    });
  }
  visibleCameras(){ const focused=this.focusedCameraId(); return focused?this.roomCameras().filter(camera=>camera.id===focused):this.roomCameras(); }
  focusCamera(id:string){ this.focusedCameraId.set(this.focusedCameraId()===id?null:id); }
  selectCamera(camera:RoomCamera){ this.stopAllPtz();this.activeCameraId.set(camera.id); }
  @HostListener("document:keydown",["$event"]) keyDown(event:KeyboardEvent){const direction=({ArrowUp:"UP",ArrowRight:"RIGHT",ArrowDown:"DOWN",ArrowLeft:"LEFT"} as const)[event.key as "ArrowUp"|"ArrowRight"|"ArrowDown"|"ArrowLeft"];if(!direction||event.repeat||this.isEditing(event.target))return;const camera=this.roomCameras().find(item=>item.id===this.activeCameraId()&&item.provider==="TUYA");if(!camera)return;event.preventDefault();this.activePtz.add(camera.id);this.controlCamera(camera,{action:"ptz",direction});}
  @HostListener("document:keyup",["$event"]) keyUp(event:KeyboardEvent){if(!event.key.startsWith("Arrow")||this.isEditing(event.target))return;const camera=this.roomCameras().find(item=>item.id===this.activeCameraId());if(camera){event.preventDefault();this.stopPtz(camera);}}
  @HostListener("window:blur") stopAllPtz(){for(const id of [...this.activePtz]){const camera=this.roomCameras().find(item=>item.id===id);if(camera)this.stopPtz(camera);}}
  stopPtz(camera:RoomCamera){if(!this.activePtz.delete(camera.id))return;this.controlCamera(camera,{action:"ptz",direction:"STOP"});}
  private isEditing(target:EventTarget|null){return target instanceof HTMLInputElement||target instanceof HTMLTextAreaElement||target instanceof HTMLSelectElement||(target instanceof HTMLElement&&target.isContentEditable);}
  private controlCamera(camera:RoomCamera,body:unknown){this.cameraControlErrors.update(current=>{const next={...current};delete next[camera.id];return next});this.http.post(`/api/cameras/${camera.id}/control`,body).subscribe({error:({error})=>this.cameraControlErrors.update(current=>({...current,[camera.id]:error?.message||"Команда не поддерживается этой камерой"}))});}
  openCamera(camera:RoomCamera,transport:"webrtc"|"hls"="webrtc"){
    const query=transport==="hls"?"?transport=hls":"";
    this.http.get<{endpoint?:string;mode:"hls"|"player"|"webrtc"}>(`/api/cameras/${camera.id}/stream${query}`).subscribe({
      next:player=>this.cameraPlayers.update(current=>({...current,[camera.id]:{...player,safeEndpoint:player.mode==="player"?this.sanitizer.bypassSecurityTrustResourceUrl(player.endpoint!):undefined}}))
    });
  }
  fallbackCamera(camera:RoomCamera){ this.cameraPlayers.update(current=>{const next={...current};delete next[camera.id];return next});this.openCamera(camera,"hls"); }
  loadRoomGame(){ this.http.get<Game[]>("/api/games").subscribe({next:games=>this.roomGameId.set(games.find(game=>game.room_id===this.roomId())?.id||null)}); }
  startSession(){
    if(this.sessionBusy()||this.activeSession()) return;
    const minutes=Math.max(5,Math.min(240,Math.round(this.sessionMinutes()||60)));
    this.sessionMinutes.set(minutes); this.sessionBusy.set(true); this.error.set("");
    this.http.post<GameSession>("/api/sessions",{roomId:this.roomId(),gameId:this.roomGameId(),status:"RUNNING",startedAt:new Date().toISOString(),endedAt:null,remainingSeconds:minutes*60}).subscribe({
      next:session=>{this.activeSession.set(session);this.sessionBusy.set(false);this.notice.set("Игровая сессия и таймер запущены на всех устройствах.");this.command("START");},
      error:({status})=>{this.sessionBusy.set(false);if(status===409){this.notice.set("Сессия уже запущена на другом устройстве.");this.refreshSession();}else this.error.set("Не удалось запустить игровую сессию.");}
    });
  }
  finishSession(){ const session=this.activeSession();if(!session||this.sessionBusy())return;this.sessionBusy.set(true);this.http.patch<GameSession>(`/api/sessions/${session.id}`,{action:"FINISH"}).subscribe({next:()=>{this.activeSession.set(null);this.sessionBusy.set(false);this.notice.set("Игровая сессия завершена.");},error:()=>{this.sessionBusy.set(false);this.error.set("Не удалось завершить игровую сессию.");}}); }
  refreshSession(){ this.http.get<GameSession[]>("/api/sessions").subscribe({next:sessions=>this.activeSession.set(sessions.find(session=>session.room_id===this.roomId()&&(session.status==="RUNNING"||session.status==="PAUSED"))||null)}); }
  timerText(){ const session=this.activeSession();if(!session?.started_at)return `${String(this.sessionMinutes()).padStart(2,"0")}:00`;const total=session.remaining_seconds??3600;const elapsed=session.status==="RUNNING"?Math.max(0,Math.floor((this.now()-new Date(session.started_at).getTime())/1000)):0;const left=Math.max(0,total-elapsed);return `${String(Math.floor(left/60)).padStart(2,"0")}:${String(left%60).padStart(2,"0")}`; }
  connectDoorbell(){
    this.doorbellSocket?.disconnect();
    const token=sessionStorage.getItem("access_token");
    if(!token) return;
    this.doorbellSocket=io({path:"/socket.io",transports:["websocket"],auth:{token}});
    this.doorbellSocket.on("doorbell-call",(call:DoorbellCall&{room_id:string})=>{
      if(call.room_id!==this.roomId()) return;
      this.doorbellCalls.update(items=>[call,...items.filter(item=>item.id!==call.id)].slice(0,20));
      if(call.id!==this.lastDoorbellId){ this.lastDoorbellId=call.id; this.playDoorbellAlert(); }
    });
  }
  loadHelpButton(){
    this.http.get<HelpButtonConfig>(`/api/rooms/${this.roomId()}/help-button`).subscribe({
      next:config=>{ this.helpCameras.set(config.cameras); this.helpCameraId.set(config.cameraId||""); },
      error:error=>this.error.set(this.message(error,"Не удалось загрузить настройку кнопки помощи."))
    });
  }
  saveHelpCamera(){
    if(!this.helpCameraId()||this.savingHelpCamera()) return;
    this.savingHelpCamera.set(true);
    this.http.patch<{cameraName:string}>(`/api/rooms/${this.roomId()}/help-button`,{cameraId:this.helpCameraId()}).subscribe({
      next:result=>{ this.savingHelpCamera.set(false); this.notice.set(`Кнопкой помощи выбрано устройство «${result.cameraName}».`); },
      error:error=>{ this.savingHelpCamera.set(false); this.error.set(this.message(error,"Не удалось сохранить кнопку помощи.")); }
    });
  }

  startPolling(){
    const safe=<T>(request:ReturnType<HttpClient["get"]>)=>request.pipe(
      switchMap(value=>of({ok:true,value} as PollResult<T>)),
      catchError(()=>of({ok:false} as PollResult<T>))
    );
    this.poll=interval(2000).pipe(startWith(0),switchMap(()=>forkJoin({
      status:safe<KrampusStatus>(this.http.get<KrampusStatus>(`/api/rooms/${this.roomId()}/krampus/status`)),
      sensors:safe<{values?:Record<string,unknown>}>(this.http.get<{values?:Record<string,unknown>}>(`/api/rooms/${this.roomId()}/krampus/sensors`)),
      logs:safe<{lines?:LogLine[]}>(this.http.get<{lines?:LogLine[]}>(`/api/rooms/${this.roomId()}/krampus/logs`)),
      doorbell:safe<DoorbellCall[]>(this.http.get<DoorbellCall[]>(`/api/rooms/${this.roomId()}/doorbell-calls`)),
      sessions:safe<GameSession[]>(this.http.get<GameSession[]>("/api/sessions"))
    }))).subscribe(result=>{
      this.agentOnline.set(result.status.ok||result.sensors.ok||result.logs.ok);
      if(result.status.ok) {
        this.status.set(result.status.value);
        const path=result.status.value.serial?.path;
        if(path&&!this.savingSerial()) this.serialPort.set(path);
      }
      if(result.sensors.ok) this.sensors.set(result.sensors.value.values||{});
      if(result.logs.ok) this.logLines.set((result.logs.value.lines||[]).slice(-150));
      if(result.sessions.ok) this.activeSession.set(result.sessions.value.find(session=>session.room_id===this.roomId()&&(session.status==="RUNNING"||session.status==="PAUSED"))||null);
      if(result.doorbell.ok){
        this.doorbellCalls.set(result.doorbell.value);
        const active=result.doorbell.value.find(call=>call.status==="RINGING");
        if(active&&active.id!==this.lastDoorbellId){ this.lastDoorbellId=active.id; this.playDoorbellAlert(); }
      }
      if(this.agentOnline()){ this.lastUpdated.set(new Date()); if(!this.busy()) this.error.set(""); }
      else this.error.set("Room-agent или локальный сервер Krampus недоступен.");
    });
  }
  activeDoorbellCall(){ return this.doorbellCalls().find(call=>call.status==="RINGING")||null; }
  openDoorbellVideo(call:DoorbellCall){
    this.doorbellVideoLoading.set(true); this.doorbellVideoError.set(""); this.doorbellStream.set("");
    this.http.get<{endpoint:string}>(`/api/cameras/${call.camera_id}/stream?transport=hls`).subscribe({
      next:result=>{ this.doorbellVideoLoading.set(false); this.doorbellStream.set(result.endpoint); },
      error:()=>{ this.doorbellVideoLoading.set(false); this.doorbellVideoError.set("Doorbell сейчас не отдаёт видео. Проверьте питание, Wi‑Fi и изображение в приложении Smart Life."); }
    });
  }
  acknowledgeDoorbell(call:DoorbellCall){
    this.http.patch(`/api/rooms/${this.roomId()}/doorbell-calls/${call.id}/acknowledge`,{}).subscribe({
      next:()=>{ this.doorbellCalls.update(items=>items.map(item=>item.id===call.id?{...item,status:"ACKNOWLEDGED",acknowledged_at:new Date().toISOString()}:item)); this.doorbellStream.set(""); this.notice.set("Вызов Doorbell принят."); },
      error:error=>this.error.set(this.message(error,"Не удалось подтвердить вызов."))
    });
  }
  private playDoorbellAlert(){
    try {
      const AudioContextClass=window.AudioContext||(window as typeof window&{webkitAudioContext:typeof AudioContext}).webkitAudioContext;
      const context=new AudioContextClass();
      const oscillator=context.createOscillator(); const gain=context.createGain();
      oscillator.type="sine"; oscillator.frequency.setValueAtTime(880,context.currentTime);
      oscillator.frequency.setValueAtTime(660,context.currentTime+.22);
      gain.gain.setValueAtTime(.18,context.currentTime); gain.gain.exponentialRampToValueAtTime(.001,context.currentTime+.55);
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime+.55);
      oscillator.onended=()=>void context.close();
    } catch { /* Visual alert remains available when autoplay audio is blocked. */ }
  }

  command(value:string,confirmRequired=false){
    if(confirmRequired&&!confirm(value==="ESTOP"?"Аварийно остановить комнату?":"Сбросить состояние комнаты?")) return;
    this.send(`/api/rooms/${this.roomId()}/krampus/command`,{command:`ADMIN ${value}`},`Команда ${value} выполнена.`);
  }
  toggle(key:ToggleKey,onCommand:string,offCommand:string){
    const next=!this.toggleOn(key);
    this.send(`/api/rooms/${this.roomId()}/krampus/command`,{command:`ADMIN ${next?onCommand:offCommand}`},`${next?"Включено":"Выключено"}: ${key}.`,()=>{
      this.toggleStates.update(states=>({...states,[key]:next}));
    });
  }
  toggleOn(key:ToggleKey){ return this.toggleStates()[key]===true; }
  toggleText(key:ToggleKey,off="Выключено",on="Включено"){ return this.toggleStates()[key]===undefined?"Состояние не получено":this.toggleOn(key)?on:off; }
  sound(action:"play"|"stop",sound?:"alert.mp3"|"calling.mp3"){
    this.send(`/api/rooms/${this.roomId()}/krampus/sound`,{action,sound},action==="stop"?"Звук остановлен.":"Звук запущен.");
  }
  loadHints(){
    this.http.get<VoiceHint[]>(`/api/rooms/${this.roomId()}/voice-hints`).subscribe({
      next:hints=>this.voiceHints.set(hints),
      error:error=>this.error.set(this.message(error,"Не удалось загрузить голосовые подсказки."))
    });
  }
  selectHintFile(event:Event){
    const input=event.target as HTMLInputElement;
    const file=input.files?.[0]||null;
    if(file&&file.size>6_000_000){ this.error.set("Аудиофайл должен быть не больше 6 МБ."); input.value=""; this.hintFile.set(null); this.hintFileName.set(""); return; }
    this.error.set(""); this.hintFile.set(file); this.hintFileName.set(file?.name||"");
    if(file&&!this.hintName().trim()) this.hintName.set(file.name.replace(/\.[^.]+$/,"").replaceAll("_"," "));
  }
  uploadHint(){
    const file=this.hintFile(); const name=this.hintName().trim();
    if(!file||!name||this.busy()) return;
    const contentType=this.audioType(file);
    if(!contentType){ this.error.set("Поддерживаются MP3, WAV, OGG, WebM и M4A."); return; }
    this.busy.set(true); this.error.set(""); this.notice.set("");
    const reader=new FileReader();
    reader.onerror=()=>{ this.busy.set(false); this.error.set("Не удалось прочитать аудиофайл."); };
    reader.onload=()=>{
      const data=String(reader.result).split(",",2)[1]||"";
      this.http.post<VoiceHint>(`/api/rooms/${this.roomId()}/voice-hints`,{name,fileName:file.name,contentType,data}).subscribe({
        next:hint=>{ this.busy.set(false); this.voiceHints.update(items=>[...items,hint].sort((a,b)=>a.name.localeCompare(b.name))); this.hintName.set(""); this.hintFile.set(null); this.hintFileName.set(""); this.notice.set(`Подсказка «${hint.name}» добавлена.`); },
        error:error=>{ this.busy.set(false); this.error.set(this.message(error,"Не удалось добавить подсказку.")); }
      });
    };
    reader.readAsDataURL(file);
  }
  playHint(hint:VoiceHint){ this.send(`/api/rooms/${this.roomId()}/voice-hints/${hint.id}/play`,{},`Подсказка «${hint.name}» отправлена в комнату.`); }
  previewHint(hint:VoiceHint){
    if(this.busy()) return;
    this.http.get(`/api/rooms/${this.roomId()}/voice-hints/${hint.id}/audio`,{responseType:"blob"}).subscribe({
      next:blob=>{ const url=URL.createObjectURL(blob); const audio=new Audio(url); audio.onended=()=>URL.revokeObjectURL(url); audio.onerror=()=>{ URL.revokeObjectURL(url); this.error.set("Не удалось воспроизвести подсказку."); }; void audio.play(); },
      error:error=>this.error.set(this.message(error,"Не удалось загрузить подсказку."))
    });
  }
  deleteHint(hint:VoiceHint){
    if(this.busy()||!confirm(`Удалить подсказку «${hint.name}»?`)) return;
    this.busy.set(true); this.error.set(""); this.notice.set("");
    this.http.delete(`/api/rooms/${this.roomId()}/voice-hints/${hint.id}`).subscribe({
      next:()=>{ this.busy.set(false); this.voiceHints.update(items=>items.filter(item=>item.id!==hint.id)); this.notice.set(`Подсказка «${hint.name}» удалена.`); },
      error:error=>{ this.busy.set(false); this.error.set(this.message(error,"Не удалось удалить подсказку.")); }
    });
  }
  fileSize(bytes:number){ return bytes>=1_000_000?`${(bytes/1_000_000).toFixed(1)} МБ`:`${Math.ceil(bytes/1000)} КБ`; }
  private audioType(file:File){
    const byExtension:Record<string,string>={mp3:"audio/mpeg",wav:"audio/wav",ogg:"audio/ogg",webm:"audio/webm",m4a:"audio/mp4"};
    const extension=file.name.split(".").pop()?.toLowerCase()||"";
    return byExtension[extension]||(["audio/mpeg","audio/wav","audio/x-wav","audio/ogg","audio/webm","audio/mp4","audio/x-m4a"].includes(file.type)?file.type:"");
  }
  async startTalking(event:Event){
    event.preventDefault();
    if(this.recording()||this.busy()||!this.roomId()) return;
    try {
      this.voiceStatus.set("Подключение микрофона…");
      this.microphone=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      const supported=["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus","audio/ogg"].find(type=>MediaRecorder.isTypeSupported(type));
      if(!supported) throw new Error("VOICE_FORMAT_UNSUPPORTED");
      const token=sessionStorage.getItem("access_token");
      if(!token) throw new Error("UNAUTHORIZED");
      this.voiceSocket=io("/voice",{path:"/socket.io",transports:["websocket"],auth:{token},reconnection:false});
      await new Promise<void>((resolve,reject)=>{
        const timeout=setTimeout(()=>reject(new Error("VOICE_CONNECTION_TIMEOUT")),7000);
        this.voiceSocket!.once("connect_error",reject);
        this.voiceSocket!.emit("start",{roomId:this.roomId(),contentType:supported},(result:{success:boolean;error?:string})=>{
          clearTimeout(timeout);
          result?.success?resolve():reject(new Error(result?.error||"VOICE_START_FAILED"));
        });
      });
      this.recorder=new MediaRecorder(this.microphone,{mimeType:supported,audioBitsPerSecond:64000});
      this.recorder.ondataavailable=event=>{
        if(event.data.size) void event.data.arrayBuffer().then(data=>this.voiceSocket?.emit("chunk",data));
      };
      this.recorder.onerror=()=>{ this.voiceStatus.set("Ошибка записи микрофона."); this.stopTalking(); };
      this.recorder.onstop=()=>setTimeout(()=>this.voiceSocket?.emit("stop",{},()=>this.closeVoice()),300);
      this.recorder.start(250);
      this.recording.set(true); this.voiceStatus.set("Идёт передача голоса в комнату.");
    } catch(error){
      this.closeVoice();
      const code=error instanceof Error?error.message:"";
      this.voiceStatus.set(code==="NotAllowedError"?"Нет разрешения на использование микрофона.":`Голосовая связь недоступна${code?` (${code})`:""}.`);
    }
  }
  stopTalking(){
    if(!this.recording()) return;
    this.recording.set(false); this.voiceStatus.set("Завершение передачи…");
    if(this.recorder?.state!=="inactive") this.recorder?.stop(); else this.closeVoice();
  }
  private closeVoice(){
    this.voiceSocket?.emit("stop",{},()=>this.voiceSocket?.disconnect());
    this.voiceSocket?.disconnect(); this.voiceSocket=undefined;
    this.microphone?.getTracks().forEach(track=>track.stop()); this.microphone=undefined; this.recorder=undefined;
    this.recording.set(false);
    if(!this.voiceStatus().includes("недоступна")&&!this.voiceStatus().includes("разрешения")) this.voiceStatus.set("Передача завершена. Удерживайте кнопку, чтобы говорить.");
  }
  private send(url:string,body:unknown,success:string,onSuccess?:()=>void){
    if(this.busy()||!this.roomId()) return;
    this.busy.set(true); this.error.set(""); this.notice.set("");
    this.http.post(url,body).subscribe({
      next:()=>{ this.busy.set(false); onSuccess?.(); this.notice.set(success); },
      error:error=>{ this.busy.set(false); this.error.set(this.message(error,"Команда не доставлена.")); }
    });
  }
  saveSerialPort(){
    const path=this.serialPort().trim();
    if(this.savingSerial()||!this.roomId()||!path) return;
    this.savingSerial.set(true); this.error.set(""); this.notice.set("");
    this.http.post(`/api/rooms/${this.roomId()}/krampus/serial`,{path}).subscribe({
      next:()=>{ this.savingSerial.set(false); this.serialPort.set(path); this.notice.set(`Arduino переключена на ${path}.`); },
      error:error=>{ this.savingSerial.set(false); this.error.set(this.message(error,"Не удалось переключить порт Arduino.")); }
    });
  }
  private message(error:HttpErrorResponse,fallback:string){ return typeof error.error?.error==="string" ? `${fallback} (${error.error.error})` : fallback; }
  arduinoOnline(){ return this.status()?.serial?.enabled===true; }
  gameState(){ return this.status()?.game?.state||String(this.status()?.["state"]||"—"); }
  serialPath(){ return this.status()?.serial?.path||"—"; }
  sensorEntries(){ return Object.entries(this.sensors()).sort(([a],[b])=>a.localeCompare(b)); }
  sensorActive(value:unknown){ return value===1||value===true||value==="1"||value==="ON"; }
  sensorValue(value:unknown){ return typeof value==="boolean"?(value?"ON":"OFF"):String(value??"—"); }
  sensorLabel(key:string){ return key.replaceAll("_"," ").replace(/\b\w/g,char=>char.toUpperCase()); }
  logTime(line:LogLine){ const date=line.at?new Date(line.at):null; return date&&!Number.isNaN(date.getTime())?date.toLocaleTimeString("ru-RU",{hour12:false}):"—"; }
  ngOnDestroy(){ this.stopAllPtz(); this.poll?.unsubscribe(); if(this.clockTimer)clearInterval(this.clockTimer); this.doorbellSocket?.disconnect(); this.closeVoice(); }
}
