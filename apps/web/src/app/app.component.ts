import { Component, HostListener, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { filter } from "rxjs";
import { CameraOverlayComponent } from "./core/camera-overlay.component";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CameraOverlayComponent],
  template: `
    @if (showLogout()) {
      @if (!isCameraViewer()) {
        <aside class="desktop-nav" aria-label="Основная навигация">
          <a class="desktop-brand" routerLink="/" aria-label="QuestControl — обзор">
            <strong>QUEST</strong><span>CONTROL</span>
          </a>
          <details class="desktop-account-menu">
            <summary>
              <span class="account-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M5 21a7 7 0 0 1 14 0"/></svg></span>
              <span class="account-copy"><b>Аккаунт</b><small>Тема и профиль</small></span>
              <i>⌄</i>
            </summary>
            <div class="account-menu-actions">
              <button class="theme-toggle" (click)="toggleTheme()"><span>{{darkMode() ? '☀' : '☾'}}</span>{{darkMode() ? 'Светлая тема' : 'Тёмная тема'}}</button>
              <button class="password" (click)="changePassword()">Сменить пароль</button>
              <button class="logout" (click)="logout()">Выйти</button>
            </div>
          </details>
          <nav class="desktop-nav-links">
            <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-7h6v7"/></svg>Обзор</a>
            <a routerLink="/bookings" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/></svg>Брони</a>
            @if (canUseWorkTime()) {<a routerLink="/work-schedules" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2"/></svg>Смены</a>}
          </nav>

          <p class="desktop-nav-title">Площадки</p>
          <nav class="desktop-nav-links compact">
            <a routerLink="/cameras" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3z"/><path d="m17 11 4-2v8l-4-2"/><circle cx="10" cy="13" r="2.5"/></svg>Камеры</a>
            <a routerLink="/locations" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>Локации</a>
            <a routerLink="/rooms" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 21V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v17M2 21h20"/><path d="M8 6h4M8 10h4M8 14h4M16 17h.01"/></svg>Комнаты</a>
          </nav>

          @if (isAdmin()) {
            <details class="desktop-tools" [open]="managementOpen()">
              <summary (click)="$event.preventDefault();managementOpen.update(value=>!value)"><span>Управление и настройки</span><i>⌄</i></summary>
              <nav class="desktop-nav-links compact">
                <a routerLink="/sessions" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4Z"/></svg>Сессии</a>
                <a routerLink="/inventory" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m21 8-9 5-9-5 9-5zM3 8v8l9 5 9-5V8M12 13v8"/></svg>Инвентарь</a>
                <a routerLink="/users" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M18 20a5.5 5.5 0 0 0-2.5-4.6"/></svg>Пользователи</a>
                <a routerLink="/camera-settings" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.55 2.55-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.55v.09h-3.6v-.09a1.7 1.7 0 0 0-1.03-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06-2.55-2.55.06-.06A1.7 1.7 0 0 0 5.6 15a1.7 1.7 0 0 0-1.55-1.03H4v-3.6h.05A1.7 1.7 0 0 0 5.6 9.34a1.7 1.7 0 0 0-.34-1.88L5.2 7.4l2.55-2.55.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.03-1.55v-.09h3.6v.09a1.7 1.7 0 0 0 1.03 1.55 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.55 2.55-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.55 1.03h.09v3.6h-.09A1.7 1.7 0 0 0 19.4 15Z"/></svg>Настройки камер</a>
                <a routerLink="/ai-dataset" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>AI и датасет</a>
                <a routerLink="/integrations" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 8 3-3a4 4 0 0 1 6 5l-3 3M16 16l-3 3a4 4 0 0 1-6-5l3-3M9 15l6-6"/></svg>Интеграции</a>
              </nav>
            </details>
          }
          <p class="desktop-nav-title">Дополнительно</p>
          <nav class="desktop-nav-links compact">
            <a routerLink="/documents" routerLinkActive="active"><svg class="nav-glyph" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M8 13h8M8 17h6"/></svg>Документы</a>
          </nav>
        </aside>
      } @else {
        <div class="camera-account-actions">
          <button class="logout" (click)="logout()">Выйти</button>
        </div>
      }

      @if(!isCameraViewer()) {<div class="mobile-nav-layer">
        <nav class="mobile-nav" aria-label="Основная навигация">
          <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">
            <i class="mobile-tab-icon home-icon" aria-hidden="true"></i><span>Обзор</span>
          </a>
          <a routerLink="/bookings" routerLinkActive="active">
            <i class="mobile-tab-icon bookings-icon" aria-hidden="true"></i><span>Брони</span>
          </a>
          @if(canUseWorkTime()) {<a routerLink="/work-schedules" routerLinkActive="active">
            <i class="mobile-tab-icon schedule-icon" aria-hidden="true"></i><span>Смены</span>
          </a>}
          <a routerLink="/cameras" routerLinkActive="active">
            <i class="mobile-tab-icon cameras-icon" aria-hidden="true"></i><span>Камеры</span>
          </a>
          <button type="button" [class.active]="moreActive() || mobileMenuOpen()" [attr.aria-expanded]="mobileMenuOpen()" (click)="mobileMenuOpen.set(true)">
            <i class="mobile-tab-icon more-icon" aria-hidden="true"></i><span>Ещё</span>
          </button>
        </nav>
      </div>}

      @if (mobileMenuOpen() && !isCameraViewer()) {
        <div class="mobile-menu-backdrop" role="presentation" (click)="mobileMenuOpen.set(false)">
          <section class="mobile-menu-sheet" role="dialog" aria-modal="true" aria-label="Дополнительная навигация" (click)="$event.stopPropagation()">
            <div class="sheet-handle"></div>
            <header>
              <div><small>QUESTCONTROL</small><h2>Ещё</h2></div>
              <button type="button" aria-label="Закрыть меню" (click)="mobileMenuOpen.set(false)">×</button>
            </header>
            <div class="mobile-menu-links">
              <p class="mobile-menu-group">Площадки</p>
              <a routerLink="/locations" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Локации</b><span>Площадки и контакты</span></a>
              <a routerLink="/rooms" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Комнаты</b><span>Зоны, игры и устройства</span></a>
              @if (isAdmin()) {
                <p class="mobile-menu-group">Управление</p>
                <a routerLink="/sessions" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Сессии</b><span>История игр и статистика</span></a>
              }
              @if (isAdmin()) {
                <a routerLink="/inventory" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Инвентарь</b><span>Магниты и расходники</span></a>
                <a routerLink="/users" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Пользователи</b><span>Доступ команды</span></a>
                <a routerLink="/camera-settings" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Настройки камер</b><span>Планы и привязка камер</span></a>
                <a routerLink="/ai-dataset" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>AI Датасет и Модель</b><span>Разметка, обучение и валидация моделей</span></a>
                <a routerLink="/integrations" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Интеграции API</b><span>Источники и форматы бронирований</span></a>
                <a routerLink="/bookings" [queryParams]="{ history: '1' }" (click)="mobileMenuOpen.set(false)"><b>Импорт истории</b><span>Служебная загрузка старых броней</span></a>
              }
              <p class="mobile-menu-group">Дополнительно</p>
              <a routerLink="/documents" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Документы</b><span>Подпись, шаблоны и отчёты</span></a>
              @if (!isStandalone()) {
                <button type="button" class="menu-link-button install-app" (click)="installApp()"><b>Установить приложение</b><span>Добавить QuestControl на главный экран</span></button>
              }
            </div>
            <div class="mobile-account-actions">
              <button class="theme-toggle" (click)="toggleTheme()"><span>{{darkMode()?'☀':'☾'}}</span>{{darkMode()?'Светлая тема':'Тёмная тема'}}</button>
              <button class="password" (click)="changePassword()">Сменить пароль</button>
              <button class="logout" (click)="logout()">Выйти</button>
            </div>
          </section>
        </div>
      }

      @if (!currentUrl().startsWith("/krampus")) { <app-camera-overlay /> }
    }
    <router-outlet />
  `,
  styles: [`
    .desktop-nav{position:fixed;z-index:1000;inset:0 auto 0 0;display:flex;width:280px;flex-direction:column;padding:28px 16px 18px;background:linear-gradient(180deg,#101827 0%,#0e192b 100%);box-shadow:12px 0 35px #15203612;color:#fff;overflow:auto;scrollbar-width:none}.desktop-nav::-webkit-scrollbar{display:none}.desktop-brand{display:flex;align-items:baseline;gap:5px;margin:0 12px 14px;color:#fff;text-decoration:none}.desktop-brand strong{color:#9297ff;font-size:27px;font-weight:800;letter-spacing:-1.2px;text-shadow:0 0 20px #7178ff40}.desktop-brand span{font-size:10px;font-weight:800;letter-spacing:2px}.desktop-account-menu{margin:0 6px 20px;border:1px solid #ffffff10;border-radius:12px;background:#ffffff04}.desktop-account-menu summary{display:flex;align-items:center;gap:9px;padding:9px 10px;cursor:pointer;list-style:none}.desktop-account-menu summary::-webkit-details-marker{display:none}.account-mark{display:grid;width:25px;height:25px;place-items:center;border-radius:8px;background:linear-gradient(145deg,#818aff,#5663dc);box-shadow:0 5px 13px #5866d640;color:#fff}.account-mark svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.account-copy{display:grid;min-width:0;flex:1;gap:1px}.account-copy b{font-size:12px}.account-copy small{color:#74839b;font-size:9px;font-weight:700}.desktop-account-menu summary i{color:#8d9ab0;font-size:16px;font-style:normal;transition:transform .18s}.desktop-account-menu[open] summary i{transform:rotate(180deg)}.account-menu-actions{display:grid;gap:5px;padding:0 6px 6px}.account-menu-actions button{width:100%;padding:8px 9px;border-radius:8px;box-shadow:none;font-size:12px;text-align:left}.account-menu-actions .theme-toggle{justify-content:flex-start}.desktop-nav-links{display:grid;gap:4px}.desktop-nav-links a{position:relative;display:flex;align-items:center;gap:13px;min-height:46px;padding:10px 12px;border:0;border-radius:12px;color:#9ba9c0;font-size:14px;font-weight:700;text-decoration:none;transition:background .18s,color .18s,transform .18s}.desktop-nav-links a:hover{background:#ffffff09;color:#e8ecf7;transform:translateX(2px)}.desktop-nav-links a.active{background:linear-gradient(100deg,#6671e344,#5563ca15);box-shadow:inset 2px 0 #8e96ff;color:#fff}.desktop-nav-links a.active:after{position:absolute;right:12px;width:5px;height:5px;border-radius:50%;background:#aeb5ff;box-shadow:0 0 12px #aeb5ff;content:""}.nav-glyph{display:block;width:22px;height:22px;min-width:22px;min-height:22px;flex:0 0 22px;overflow:visible;fill:none!important;stroke:currentColor!important;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle;color:#71819b;transition:color .18s,transform .18s,filter .18s}.nav-glyph *{fill:none!important;stroke:currentColor!important;vector-effect:non-scaling-stroke}.desktop-nav-links a:hover .nav-glyph{color:#c7d0e3;transform:scale(1.06)}.desktop-nav-links a.active .nav-glyph{color:#aeb5ff;filter:drop-shadow(0 2px 5px #8791ff70)}.desktop-nav-title{margin:27px 12px 8px;color:#65758f;font-size:10px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}.desktop-nav-links.compact{gap:2px}.desktop-nav-links.compact a{min-height:39px;padding:7px 12px;font-size:13px}.desktop-nav-links.compact .nav-glyph{width:20px;height:20px;min-width:20px;min-height:20px;flex-basis:20px}.desktop-tools{margin-top:22px;border:1px solid #ffffff0d;border-radius:12px;background:#ffffff04}.desktop-tools summary{display:flex;align-items:center;justify-content:space-between;padding:11px 12px;color:#8391a8;font-size:11px;font-weight:800;cursor:pointer;list-style:none}.desktop-tools summary::-webkit-details-marker{display:none}.desktop-tools summary i{font-size:16px;font-style:normal;transition:transform .18s}.desktop-tools[open] summary{color:#c9d1df}.desktop-tools[open] summary i{transform:rotate(180deg)}.desktop-tools nav{padding:0 5px 6px}.theme-toggle{display:flex;align-items:center;justify-content:center;gap:7px;border:1px solid #344054;background:#151f31;color:#d7deea}.theme-toggle span{font-size:16px}.password{border:1px solid #344054;background:#243047;color:#fff}.logout{border:1px solid #344054;background:#182235;color:#fff}.logout:hover{background:#b42318;border-color:#b42318}.camera-account-actions{position:fixed;z-index:1000;right:18px;bottom:18px}.camera-account-actions button{box-shadow:none}
    .mobile-nav-layer,.mobile-menu-backdrop{display:none}
    @media(max-width:760px){
      .desktop-nav{display:none}.camera-account-actions{right:12px;bottom:12px}
      .mobile-nav-layer{position:fixed!important;z-index:950;inset:auto 0 0;display:flex;justify-content:center;padding:0 max(12px,env(safe-area-inset-right,0px)) 0 max(12px,env(safe-area-inset-left,0px));background:#0d1524;pointer-events:none;isolation:isolate}
      .mobile-nav{position:relative!important;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);width:100%;max-width:520px;gap:4px;padding:6px 6px calc(6px + env(safe-area-inset-bottom,0px));border:1px solid #ffffff1c;border-bottom:0;border-radius:20px 20px 0 0;background:linear-gradient(145deg,#151f33f7,#0d1524fa);box-shadow:0 18px 50px #10182745,0 2px 0 #ffffff0d inset;backdrop-filter:blur(18px);pointer-events:auto}
      .mobile-nav a,.mobile-nav>button{position:relative;display:grid;min-width:0;min-height:56px;place-items:center;align-content:center;gap:4px;padding:5px 3px;border:0;border-radius:14px;background:transparent;box-shadow:none;color:#8f9db3;text-decoration:none;transform:none;transition:background .18s,color .18s,transform .15s,box-shadow .18s}
      .mobile-nav a:hover,.mobile-nav>button:hover:not(:disabled){background:#ffffff0a;box-shadow:none;transform:none}
      .mobile-nav a:active,.mobile-nav>button:active{transform:scale(.96)}
      .mobile-nav a.active,.mobile-nav>button.active{background:linear-gradient(145deg,#6574ef,#5257d7);box-shadow:0 7px 18px #3f46c94d,0 1px 0 #ffffff30 inset;color:#fff}
      .mobile-nav a.active:after,.mobile-nav>button.active:after{position:absolute;top:4px;left:50%;width:14px;height:2px;border-radius:99px;background:#cfd4ff;box-shadow:0 0 9px #aeb7ff;content:"";transform:translateX(-50%)}
      .mobile-nav span{font-size:10px;font-weight:700;letter-spacing:.01em;line-height:1.1}
      .mobile-tab-icon{position:relative;display:block;width:28px;height:28px;border:1px solid #ffffff0a;border-radius:9px;background:#ffffff08;color:currentColor}
      .mobile-nav .active .mobile-tab-icon{border-color:#ffffff18;background:#ffffff14}
      .home-icon:before{position:absolute;top:6px;left:8px;width:10px;height:10px;border-top:2px solid currentColor;border-left:2px solid currentColor;content:"";transform:rotate(45deg)}
      .home-icon:after{position:absolute;left:8px;bottom:5px;width:10px;height:9px;border:2px solid currentColor;border-top:0;border-radius:0 0 2px 2px;content:""}
      .bookings-icon:before{position:absolute;inset:6px 5px 5px;border:2px solid currentColor;border-radius:4px;content:""}
      .bookings-icon:after{position:absolute;top:10px;left:9px;width:3px;height:3px;border-radius:1px;background:currentColor;box-shadow:6px 0 currentColor,0 6px currentColor,6px 6px currentColor;content:""}
      .schedule-icon:before{position:absolute;inset:6px 5px 5px;border:2px solid currentColor;border-radius:4px;content:""}.schedule-icon:after{position:absolute;top:11px;left:8px;width:12px;height:2px;background:currentColor;box-shadow:0 5px currentColor,0 10px currentColor;content:""}
      .cameras-icon:before{position:absolute;inset:7px 4px;border:2px solid currentColor;border-radius:5px;content:""}
      .cameras-icon:after{position:absolute;top:11px;left:11px;width:6px;height:6px;border:2px solid currentColor;border-radius:50%;content:""}
      .more-icon:before{position:absolute;top:12px;left:6px;width:4px;height:4px;border-radius:50%;background:currentColor;box-shadow:6px 0 currentColor,12px 0 currentColor;content:""}
      .mobile-menu-backdrop{position:fixed;z-index:980;inset:0;display:flex;align-items:flex-end;padding-top:60px;background:#10182780;backdrop-filter:blur(4px)}
      .mobile-menu-sheet{width:100%;max-height:calc(100vh - 54px);max-height:calc(100dvh - 54px);overflow:auto;margin:0;padding:8px 16px 18px;padding-bottom:calc(18px + env(safe-area-inset-bottom,0px));border-radius:22px 22px 0 0;background:#f7f8fb;box-shadow:0 -24px 60px #10182738;animation:sheet-in .18s ease-out}
      .sheet-handle{width:42px;height:4px;margin:2px auto 15px;border-radius:999px;background:#c7ccd6}
      .mobile-menu-sheet>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
      .mobile-menu-sheet header small{color:#667085;font-size:9px;font-weight:800;letter-spacing:.13em}.mobile-menu-sheet h2{margin:3px 0 0;font-size:26px}.mobile-menu-sheet header button{display:grid;width:42px;height:42px;padding:0;place-items:center;border-radius:50%;background:#e9ecf2;box-shadow:none;color:#344054;font-size:24px}
      .mobile-menu-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mobile-menu-group{grid-column:1/-1;margin:8px 1px -2px;color:#667085;font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.mobile-menu-links a,.mobile-menu-links .menu-link-button{display:grid;align-content:start;min-height:88px;padding:15px;border:1px solid #e0e4eb;border-radius:14px;background:#fff;box-shadow:none;color:#111827;text-align:left;text-decoration:none}.mobile-menu-links a.active{border-color:#9ba8f7;background:#f0f2ff}.mobile-menu-links .install-app{border-color:#c9d0ff;background:linear-gradient(145deg,#f2f3ff,#fff)}.mobile-menu-links a:hover,.mobile-menu-links .menu-link-button:hover{transform:none;box-shadow:none}.mobile-menu-links b{font-size:14px}.mobile-menu-links span{margin-top:6px;color:#7a8495;font-size:10px;line-height:1.35}
      .mobile-account-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:16px;padding-top:16px;border-top:1px solid #dfe3e9}.mobile-account-actions button{width:100%;min-height:46px;box-shadow:none}.mobile-account-actions .theme-toggle{grid-column:1/-1}.mobile-account-actions .password{background:#243047}.mobile-account-actions .logout{background:#fff;border-color:#e5b8be;color:#b42336}
      @keyframes sheet-in{from{transform:translateY(24px);opacity:.5}}
    }
    @media(min-width:761px) and (max-width:1000px){.desktop-nav{width:228px;padding-inline:12px}.desktop-brand{margin-inline:7px}.desktop-brand strong{font-size:23px}.desktop-account-menu{margin-inline:2px}.desktop-nav-links a{padding-inline:8px}.desktop-nav-title{margin-inline:8px}}
    @media(max-width:390px){.mobile-menu-sheet{padding-inline:12px}.mobile-menu-links{grid-template-columns:1fr}.mobile-menu-links a,.mobile-menu-links .menu-link-button{min-height:70px}}
  `],
})
export class AppComponent {
  private router = inject(Router);
  private http = inject(HttpClient);
  showLogout = signal(this.managementRoute(this.router.url));
  mobileMenuOpen = signal(false);
  currentUrl = signal(this.router.url);
  managementOpen = signal(this.managementPath(this.router.url));
  darkMode = signal(true);
  isAdmin = signal(false);
  canUseWorkTime = signal(false);
  isCameraViewer = signal(false);
  isStandalone = signal(window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
  installPrompt = signal<InstallPromptEvent | null>(null);

  constructor() {
    localStorage.setItem("questcontrol.theme", "dark");
    this.applyTheme();
    this.updateManagementClass();
    this.router.events.pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd)).subscribe((event) => {
      this.showLogout.set(this.managementRoute(event.urlAfterRedirects));
      this.currentUrl.set(event.urlAfterRedirects);
      if (this.managementPath(event.urlAfterRedirects)) this.managementOpen.set(true);
      this.mobileMenuOpen.set(false);
      this.updateManagementClass();
    });
  }

  @HostListener("document:keydown.escape")
  closeMobileMenu() { this.mobileMenuOpen.set(false); }

  @HostListener("window:beforeinstallprompt", ["$event"])
  captureInstallPrompt(event: Event) {
    event.preventDefault();
    this.installPrompt.set(event as InstallPromptEvent);
  }

  @HostListener("window:appinstalled")
  installed() {
    this.installPrompt.set(null);
    this.isStandalone.set(true);
  }

  moreActive() {
    const [path, query = ""] = this.currentUrl().split("?");
    return new URLSearchParams(query).get("history") === "1" || !["/", "/bookings", "/work-schedules", "/cameras"].includes(path);
  }

  private managementPath(url: string) {
    const path = url.split("?")[0];
    return ["/sessions", "/inventory", "/users", "/camera-settings", "/ai-dataset", "/integrations"].includes(path);
  }

  toggleTheme() {
    this.darkMode.update(value=>!value);
    localStorage.setItem("questcontrol.theme",this.darkMode()?"dark":"light");
    this.applyTheme();
  }

  private applyTheme() {
    document.documentElement.classList.toggle("dark-theme",this.darkMode());
  }

  logout() {
    this.mobileMenuOpen.set(false);
    document.body.classList.remove("management-user");
    document.body.classList.remove("management-shell");
    sessionStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    localStorage.removeItem("questcontrol.selectedCameras");
    void this.router.navigateByUrl("/login");
  }

  private updateManagementClass() {
    document.body.classList.toggle("management-shell", this.showLogout());
    try {
      const token = sessionStorage.getItem("access_token");
      const role = token ? JSON.parse(atob(token.split(".")[1])).role : null;
      const admin = role === "OWNER" || role === "ADMIN";
      this.isAdmin.set(admin);
      this.canUseWorkTime.set(admin || role === "OPERATOR");
      this.isCameraViewer.set(role === "CAMERA_VIEWER");
      document.body.classList.toggle("management-user", admin);
    } catch {
      this.isAdmin.set(false);
      this.canUseWorkTime.set(false);
      this.isCameraViewer.set(false);
      document.body.classList.remove("management-user");
    }
  }

  private managementRoute(url: string) {
    return url !== "/login" && !url.startsWith("/reception/checkin") && !url.startsWith("/watch/");
  }

  async installApp() {
    const installPrompt = this.installPrompt();
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") this.installPrompt.set(null);
      return;
    }
    const appleDevice = /iphone|ipad|ipod/i.test(navigator.userAgent);
    alert(appleDevice
      ? "В Safari нажмите «Поделиться», затем «На экран Домой». QuestControl будет открываться как приложение."
      : "Откройте меню браузера и выберите «Установить приложение» или «Добавить на главный экран».");
  }

  changePassword() {
    this.mobileMenuOpen.set(false);
    const currentPassword = prompt("Введите текущий пароль:");
    if (currentPassword === null) return;
    const newPassword = prompt("Введите новый пароль (минимум 12 символов):");
    if (newPassword === null) return;
    if (newPassword.length < 12) {
      alert("Новый пароль должен содержать минимум 12 символов.");
      return;
    }
    const confirmation = prompt("Повторите новый пароль:");
    if (confirmation !== newPassword) {
      alert("Пароли не совпадают.");
      return;
    }
    this.http.patch("/api/auth/password", { currentPassword, newPassword }).subscribe({
      next: () => { alert("Пароль изменён. Войдите заново."); this.logout(); },
      error: ({ error }) => alert(error?.error === "CURRENT_PASSWORD_INVALID" ? "Текущий пароль указан неверно." : "Не удалось изменить пароль."),
    });
  }
}
