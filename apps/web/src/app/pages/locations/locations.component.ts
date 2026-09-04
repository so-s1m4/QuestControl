import { Component, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";
import { FormsModule } from "@angular/forms";

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
  imports:[RouterLink,FormsModule],
  template:`
  <main>
    <aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="sessions-nav" routerLink="/sessions">Сессии</a><a class="active" routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/inventory">Инвентарь</a><a routerLink="/users">Пользователи</a></nav></aside>
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
          <div class="card-actions"><a class="bookings-link" [routerLink]="['/bookings']">Открыть бронирования →</a><button class="secondary" (click)="openSettings(location)">Настройки</button></div>
        </article>}@empty{@if(!loading()&&!error()){<div class="empty"><b>Локаций пока нет</b><span>Time to Grow не вернул доступных площадок.</span></div>}}
      </div>
    </section>
  </main>
  @if(settingsLocation()){<div class="backdrop" (click)="closeSettings()"><section class="dialog" role="dialog" aria-modal="true" (click)="$event.stopPropagation()"><header><div><small>НАСТРОЙКИ ЛОКАЦИИ</small><h2>{{settingsLocation()!.name}}</h2><p>Запись завершённых игр в Google Sheets</p></div><button class="close" (click)="closeSettings()">×</button></header><div class="body"><label>URL веб-приложения<input type="url" [(ngModel)]="sheetsDraft.url" placeholder="https://script.google.com/macros/s/…/exec"></label><label>Секретный ключ<input type="password" [(ngModel)]="sheetsDraft.secret" [placeholder]="sheetsConfigured()?'Сохранён — оставьте пустым':'Введите ключ'"></label><p class="hint">Подключение применяется только к этой локации. Ключ хранится зашифрованно.</p>@if(settingsNotice()){<p class="settings-notice" [class.success]="settingsSuccess()">{{settingsNotice()}}</p>}<footer><button class="secondary" [disabled]="settingsBusy()" (click)="testSheets()">Проверить</button><button [disabled]="settingsBusy()" (click)="saveSheets()">{{settingsBusy()?'Сохраняем…':'Сохранить'}}</button></footer></div></section></div>}
  `,
  styles:[`
    .secondary{background:#eef1f6;color:#344054;box-shadow:none}
    .location-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:24px}
    .location-grid article{padding:22px;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 24px #19213a08}
    .location-head{display:flex;justify-content:space-between;align-items:start;gap:16px}
    .location-head h3{margin:6px 0 20px;font-size:21px}.eyebrow{color:var(--primary);font-size:10px;font-weight:800;letter-spacing:1px}
    .timezone{padding:7px 9px;border-radius:999px;background:#eef4ff;color:#3448a5;font-size:10px;font-weight:800}
    dl{display:grid;gap:12px;margin:0}dl div{display:grid;grid-template-columns:75px 1fr;gap:12px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}dd a{color:var(--ink);text-decoration:none}dd a:hover{color:var(--primary)}
    .card-actions{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:20px}.bookings-link{color:var(--primary);text-decoration:none;font-weight:700}.empty{grid-column:1/-1}
    .backdrop{position:fixed;z-index:2000;inset:0;display:grid;place-items:center;padding:20px;background:#10182899}.dialog{width:min(620px,100%);overflow:hidden;border-radius:18px;background:#fff}.dialog>header{display:flex;justify-content:space-between;padding:22px;border-bottom:1px solid var(--line)}.dialog header h2{margin:4px 0}.dialog header p{margin:0;color:var(--muted)}.dialog small{color:var(--primary);font-weight:800;letter-spacing:.08em}.close{width:42px;height:42px;padding:0;border-radius:50%;background:#f2f4f7;color:#344054}.body{display:grid;gap:15px;padding:22px}.hint{margin:0;color:var(--muted)}.settings-notice{margin:0;padding:10px 12px;border-radius:10px;background:#fff1f2;color:#b42318}.settings-notice.success{background:#ecfdf3;color:#067647}.body footer{display:flex;justify-content:flex-end;gap:10px}
    @media(max-width:900px){.location-grid{grid-template-columns:1fr}}@media(max-width:600px){.location-grid article{padding:17px}.location-head{align-items:flex-start;flex-direction:column}.location-head h3{margin-bottom:8px}dl div{grid-template-columns:1fr;gap:3px}.bookings-link{min-height:44px;padding:11px 0}}
  `]
})
export class LocationsComponent{
  private http=inject(HttpClient);
  locations=signal<Location[]>([]);
  loading=signal(false);
  error=signal("");
  settingsLocation=signal<Location|null>(null);settingsBusy=signal(false);settingsNotice=signal("");settingsSuccess=signal(false);sheetsConfigured=signal(false);sheetsDraft={url:"",secret:""};
  constructor(){this.load();}
  load(){this.loading.set(true);this.error.set("");this.http.get<{data:Location[]}>("/api/time-to-grow/clubs").subscribe({next:r=>{this.locations.set(r.data);this.loading.set(false);},error:()=>{this.locations.set([]);this.loading.set(false);this.error.set("Не удалось загрузить локации Time to Grow.");}});}
  openSettings(location:Location){this.settingsLocation.set(location);this.settingsNotice.set("");this.settingsSuccess.set(false);this.sheetsDraft={url:"",secret:""};this.http.get<{configured:boolean;url:string}>(`/api/settings/google-sheets?clubId=${encodeURIComponent(location.id)}`).subscribe({next:value=>{this.sheetsConfigured.set(value.configured);this.sheetsDraft.url=value.url||"";if(value.configured){this.settingsNotice.set("Google Sheets подключён к этой локации.");this.settingsSuccess.set(true);}},error:()=>this.settingsNotice.set("Не удалось загрузить настройки локации.")});}
  closeSettings(){this.settingsLocation.set(null);}
  saveSheets(){const location=this.settingsLocation();if(!location||!this.sheetsDraft.url||(!this.sheetsDraft.secret&&!this.sheetsConfigured())){this.settingsNotice.set("Укажите URL и секретный ключ.");this.settingsSuccess.set(false);return;}this.settingsBusy.set(true);this.http.put("/api/settings/google-sheets",{clubId:location.id,...this.sheetsDraft}).subscribe({next:()=>{this.settingsBusy.set(false);this.sheetsConfigured.set(true);this.sheetsDraft.secret="";this.settingsNotice.set("Подключение сохранено для этой локации.");this.settingsSuccess.set(true);},error:()=>{this.settingsBusy.set(false);this.settingsNotice.set("Не удалось сохранить подключение.");this.settingsSuccess.set(false);}});}
  testSheets(){const location=this.settingsLocation();if(!location)return;this.settingsBusy.set(true);this.http.post("/api/settings/google-sheets/test",{clubId:location.id}).subscribe({next:()=>{this.settingsBusy.set(false);this.settingsNotice.set("Google Sheets отвечает — всё работает.");this.settingsSuccess.set(true);},error:()=>{this.settingsBusy.set(false);this.settingsNotice.set("Google Sheets не ответил. Проверьте публикацию скрипта.");this.settingsSuccess.set(false);}});}
}
