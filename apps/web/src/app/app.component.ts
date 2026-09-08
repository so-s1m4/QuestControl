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
          <nav class="desktop-nav-links">
            <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }"><i class="nav-glyph">⌂</i>Обзор</a>
            <a routerLink="/bookings" routerLinkActive="active"><i class="nav-glyph">▦</i>Брони</a>
            @if (canUseWorkTime()) {<a routerLink="/work-schedules" routerLinkActive="active"><i class="nav-glyph">◷</i>Смены</a>}
            <a routerLink="/documents" routerLinkActive="active"><i class="nav-glyph">▤</i>Документы</a>
          </nav>

          <p class="desktop-nav-title">Площадки</p>
          <nav class="desktop-nav-links compact">
            <a routerLink="/cameras" routerLinkActive="active"><i class="nav-glyph">◉</i>Камеры</a>
            <a routerLink="/locations" routerLinkActive="active"><i class="nav-glyph">⌖</i>Локации</a>
            <a routerLink="/rooms" routerLinkActive="active"><i class="nav-glyph">▢</i>Комнаты</a>
          </nav>

          @if (isAdmin()) {
            <p class="desktop-nav-title">Управление</p>
            <nav class="desktop-nav-links compact">
              <a routerLink="/sessions" routerLinkActive="active"><i class="nav-glyph">▷</i>Сессии</a>
              <a routerLink="/inventory" routerLinkActive="active"><i class="nav-glyph">□</i>Инвентарь</a>
              <a routerLink="/users" routerLinkActive="active"><i class="nav-glyph">♙</i>Пользователи</a>
              <a routerLink="/camera-settings" routerLinkActive="active"><i class="nav-glyph">⚙</i>Камеры: настройки</a>
              <a routerLink="/integrations" routerLinkActive="active"><i class="nav-glyph">↔</i>Интеграции API</a>
            </nav>
          }
          <div class="desktop-account-actions">
            <button class="password" (click)="changePassword()">Сменить пароль</button>
            <button class="logout" (click)="logout()">Выйти</button>
          </div>
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
          <a routerLink="/documents" routerLinkActive="active">
            <i class="mobile-tab-icon documents-icon" aria-hidden="true"></i><span>Документы</span>
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
              <a routerLink="/cameras" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Камеры</b><span>Трансляции и просмотр</span></a>
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
                <a routerLink="/integrations" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Интеграции API</b><span>Источники и форматы бронирований</span></a>
                <a routerLink="/bookings" [queryParams]="{ history: '1' }" (click)="mobileMenuOpen.set(false)"><b>Импорт истории</b><span>Служебная загрузка старых броней</span></a>
              }
              @if (!isStandalone()) {
                <button type="button" class="menu-link-button install-app" (click)="installApp()"><b>Установить приложение</b><span>Добавить QuestControl на главный экран</span></button>
              }
            </div>
            <div class="mobile-account-actions">
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
    .desktop-nav{position:fixed;z-index:1000;inset:0 auto 0 0;display:flex;width:280px;flex-direction:column;padding:26px 16px 18px;background:linear-gradient(180deg,#101827,#111c2f);box-shadow:12px 0 35px #15203612;color:#fff;overflow:auto;scrollbar-width:thin;scrollbar-color:#34415a transparent}.desktop-brand{display:flex;align-items:baseline;gap:5px;margin:0 10px 24px;color:#fff;text-decoration:none}.desktop-brand strong{color:#8b91ff;font-size:27px;font-weight:800;letter-spacing:-1.2px}.desktop-brand span{font-size:10px;font-weight:800;letter-spacing:2px}.desktop-nav-links{display:grid;gap:3px}.desktop-nav-links a{display:flex;align-items:center;gap:10px;min-height:42px;padding:9px 11px;border:1px solid transparent;border-radius:10px;color:#aab5c7;font-weight:700;text-decoration:none;transition:.18s}.desktop-nav-links a:hover,.desktop-nav-links a.active{border-color:#747cff45;background:linear-gradient(100deg,#6269e92b,#ffffff0b);color:#fff}.desktop-nav-links a.active{box-shadow:inset 3px 0 #8188ff}.nav-glyph{display:grid;width:25px;height:25px;flex:0 0 25px;place-items:center;border-radius:7px;background:#ffffff0b;color:currentColor;font-size:17px;font-style:normal;line-height:1}.desktop-nav-links a.active .nav-glyph{background:#6971e8;box-shadow:0 4px 11px #4d54c655}.desktop-nav-title{margin:22px 11px 7px;color:#6f7f98;font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.desktop-nav-links.compact a{min-height:37px;padding-block:6px;font-size:13px}.desktop-nav-links.compact .nav-glyph{width:23px;height:23px;flex-basis:23px;font-size:15px}.desktop-account-actions{display:grid;gap:7px;margin-top:auto;padding:18px 6px 2px;border-top:1px solid #ffffff12}.desktop-account-actions button{width:100%;padding:9px 11px;border-radius:9px;box-shadow:none}.password{border:1px solid #344054;background:#243047;color:#fff}.logout{border:1px solid #344054;background:#182235;color:#fff}.logout:hover{background:#b42318;border-color:#b42318}.camera-account-actions{position:fixed;z-index:1000;right:18px;bottom:18px}.camera-account-actions button{box-shadow:none}
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
      .documents-icon:before{position:absolute;top:5px;left:8px;width:11px;height:16px;border:2px solid currentColor;border-radius:2px;content:""}.documents-icon:after{position:absolute;top:10px;left:11px;width:7px;height:2px;background:currentColor;box-shadow:0 4px currentColor,0 8px currentColor;content:""}
      .cameras-icon:before{position:absolute;inset:7px 4px;border:2px solid currentColor;border-radius:5px;content:""}
      .cameras-icon:after{position:absolute;top:11px;left:11px;width:6px;height:6px;border:2px solid currentColor;border-radius:50%;content:""}
      .more-icon:before{position:absolute;top:12px;left:6px;width:4px;height:4px;border-radius:50%;background:currentColor;box-shadow:6px 0 currentColor,12px 0 currentColor;content:""}
      .mobile-menu-backdrop{position:fixed;z-index:980;inset:0;display:flex;align-items:flex-end;padding-top:60px;background:#10182780;backdrop-filter:blur(4px)}
      .mobile-menu-sheet{width:100%;max-height:calc(100vh - 54px);max-height:calc(100dvh - 54px);overflow:auto;margin:0;padding:8px 16px 18px;padding-bottom:calc(18px + env(safe-area-inset-bottom,0px));border-radius:22px 22px 0 0;background:#f7f8fb;box-shadow:0 -24px 60px #10182738;animation:sheet-in .18s ease-out}
      .sheet-handle{width:42px;height:4px;margin:2px auto 15px;border-radius:999px;background:#c7ccd6}
      .mobile-menu-sheet>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
      .mobile-menu-sheet header small{color:#667085;font-size:9px;font-weight:800;letter-spacing:.13em}.mobile-menu-sheet h2{margin:3px 0 0;font-size:26px}.mobile-menu-sheet header button{display:grid;width:42px;height:42px;padding:0;place-items:center;border-radius:50%;background:#e9ecf2;box-shadow:none;color:#344054;font-size:24px}
      .mobile-menu-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mobile-menu-group{grid-column:1/-1;margin:8px 1px -2px;color:#667085;font-size:10px;font-weight:800;letter-spacing:.11em;text-transform:uppercase}.mobile-menu-links a,.mobile-menu-links .menu-link-button{display:grid;align-content:start;min-height:88px;padding:15px;border:1px solid #e0e4eb;border-radius:14px;background:#fff;box-shadow:none;color:#111827;text-align:left;text-decoration:none}.mobile-menu-links a.active{border-color:#9ba8f7;background:#f0f2ff}.mobile-menu-links .install-app{border-color:#c9d0ff;background:linear-gradient(145deg,#f2f3ff,#fff)}.mobile-menu-links a:hover,.mobile-menu-links .menu-link-button:hover{transform:none;box-shadow:none}.mobile-menu-links b{font-size:14px}.mobile-menu-links span{margin-top:6px;color:#7a8495;font-size:10px;line-height:1.35}
      .mobile-account-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:16px;padding-top:16px;border-top:1px solid #dfe3e9}.mobile-account-actions button{width:100%;min-height:46px;box-shadow:none}.mobile-account-actions .password{background:#243047}.mobile-account-actions .logout{background:#fff;border-color:#e5b8be;color:#b42336}
      @keyframes sheet-in{from{transform:translateY(24px);opacity:.5}}
    }
    @media(min-width:761px) and (max-width:1000px){.desktop-nav{width:228px;padding-inline:12px}.desktop-brand{margin-inline:7px}.desktop-brand strong{font-size:23px}.desktop-nav-links a{padding-inline:8px}.desktop-nav-title{margin-inline:8px}.desktop-account-actions{padding-inline:2px}}
    @media(max-width:390px){.mobile-menu-sheet{padding-inline:12px}.mobile-menu-links{grid-template-columns:1fr}.mobile-menu-links a,.mobile-menu-links .menu-link-button{min-height:70px}}
  `],
})
export class AppComponent {
  private router = inject(Router);
  private http = inject(HttpClient);
  showLogout = signal(this.managementRoute(this.router.url));
  mobileMenuOpen = signal(false);
  currentUrl = signal(this.router.url);
  isAdmin = signal(false);
  canUseWorkTime = signal(false);
  isCameraViewer = signal(false);
  isStandalone = signal(window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true);
  installPrompt = signal<InstallPromptEvent | null>(null);

  constructor() {
    this.updateManagementClass();
    this.router.events.pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd)).subscribe((event) => {
      this.showLogout.set(this.managementRoute(event.urlAfterRedirects));
      this.currentUrl.set(event.urlAfterRedirects);
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
    return new URLSearchParams(query).get("history") === "1" || !["/", "/bookings", "/work-schedules", "/documents"].includes(path);
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
