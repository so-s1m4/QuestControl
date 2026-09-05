import { Component, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";
import { DatePipe } from "@angular/common";

type Connection = { configured:boolean;botUsername:string;connected:boolean;connection:{username?:string;first_name?:string;linked_at:string}|null };

@Component({
  selector: "app-telegram",
  standalone: true,
  imports: [RouterLink,DatePipe],
  template: `
    <main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a routerLink="/work-schedules">Графики работы</a><a class="active" routerLink="/telegram">Telegram</a></nav></aside>
    <section><header><div><h2>Telegram</h2><p>Личные напоминания о сменах и бронированиях</p></div></header>
    @if(loading()){<p>Проверяем подключение…</p>}@else if(!status().configured){<article class="card warning"><span>⚙️</span><div><h3>Бот пока не настроен</h3><p>Попросите владельца добавить токен бота в настройки сервера.</p></div></article>}@else if(status().connected){<article class="card connected"><span>✓</span><div><h3>Telegram подключён</h3><p>@{{status().connection?.username || status().connection?.first_name || "Ваш аккаунт"}} получает уведомления QuestControl.</p><small>Подключено: {{status().connection?.linked_at | date:'dd.MM.yyyy, HH:mm'}}</small></div><button class="secondary" (click)="disconnect()">Отключить</button></article>}@else{<article class="hero"><div class="icon">✈</div><small>ЛИЧНЫЕ УВЕДОМЛЕНИЯ</small><h3>Подключите Telegram</h3><p>Бот напомнит о вашей смене в 09:00, сообщит о новых бронях и позволит подтвердить их одним нажатием.</p><button [disabled]="busy()" (click)="createLink()">{{busy()?"Готовим ссылку…":"Подключить Telegram"}}</button>@if(linkUrl()){<a class="link" [href]="linkUrl()" target="_blank" rel="noopener">Открыть @{{status().botUsername}} в Telegram →</a><small class="expires">Ссылка действует 15 минут.</small>}@if(error()){<p class="error">{{error()}}</p>}</article>}</section></main>
  `,
  styles: [`header{margin-bottom:22px}.card,.hero{display:flex;align-items:center;gap:16px;max-width:700px;padding:24px;border:1px solid var(--line);border-radius:18px;background:#fff}.card>span{display:grid;place-items:center;width:46px;height:46px;border-radius:14px;background:#eef2ff;color:#4f46e5;font-size:23px;font-weight:900}.card h3,.card p,.hero h3,.hero p{margin:0}.card p,.hero p,small{color:var(--muted)}.card>div{flex:1}.card small{display:block;margin-top:7px}.connected{border-color:#a7e0bd;background:linear-gradient(110deg,#f1fcf5,#fff)}.connected>span{background:#d9f6e4;color:#087443}.warning{border-color:#f5d28a}.warning>span{background:#fff6df;color:#b54708}.secondary{background:#f2f4f7;color:#475467;box-shadow:none}.hero{display:grid;justify-items:start;max-width:620px;padding:36px;background:linear-gradient(135deg,#f3f0ff,#fff 55%);border-color:#d8d4fe}.hero .icon{display:grid;place-items:center;width:58px;height:58px;border-radius:18px;background:#625bf6;color:#fff;font-size:28px}.hero small{font-weight:800;letter-spacing:.09em;color:#625bf6}.hero h3{font-size:25px}.hero p{line-height:1.55;max-width:500px}.link{margin-top:4px;color:#4f46e5;font-weight:750}.expires{letter-spacing:normal;color:#667085}.error{color:#b42318!important}`]
})
export class TelegramComponent {
  private http=inject(HttpClient);
  status=signal<Connection>({configured:false,botUsername:"",connected:false,connection:null});
  loading=signal(true);busy=signal(false);error=signal("");linkUrl=signal("");
  constructor(){this.load();}
  load(){this.loading.set(true);this.http.get<Connection>("/api/telegram/connection").subscribe({next:value=>{this.status.set(value);this.loading.set(false)},error:()=>{this.error.set("Не удалось проверить подключение.");this.loading.set(false)}})}
  createLink(){this.busy.set(true);this.error.set("");this.http.post<{url:string}>("/api/telegram/link-code",{}).subscribe({next:value=>{this.linkUrl.set(value.url);this.busy.set(false);window.open(value.url,"_blank","noopener")},error:()=>{this.error.set("Не удалось создать ссылку. Попробуйте ещё раз.");this.busy.set(false)}})}
  disconnect(){if(!confirm("Отключить Telegram от этого аккаунта?"))return;this.http.delete("/api/telegram/connection").subscribe({next:()=>{this.linkUrl.set("");this.load()},error:()=>this.error.set("Не удалось отключить Telegram.")})}
}
