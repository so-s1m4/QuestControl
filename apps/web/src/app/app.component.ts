import { Component, HostListener, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { filter } from "rxjs";
import { CameraOverlayComponent } from "./core/camera-overlay.component";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, CameraOverlayComponent],
  template: `
    <router-outlet />
    @if (showLogout()) {
      <div class="account-actions">
        <button class="password" (click)="changePassword()">Сменить пароль</button>
        <button class="logout" (click)="logout()">Выйти</button>
      </div>

      <nav class="mobile-nav" aria-label="Основная навигация">
        <a routerLink="/" routerLinkActive="active" [routerLinkActiveOptions]="{ exact: true }">
          <b>⌂</b><span>Обзор</span>
        </a>
        <a routerLink="/bookings" routerLinkActive="active">
          <b>▣</b><span>Брони</span>
        </a>
        <a routerLink="/cameras" routerLinkActive="active">
          <b>◉</b><span>Камеры</span>
        </a>
        <button type="button" [class.active]="moreActive() || mobileMenuOpen()" [attr.aria-expanded]="mobileMenuOpen()" (click)="mobileMenuOpen.set(true)">
          <b>•••</b><span>Ещё</span>
        </button>
      </nav>

      @if (mobileMenuOpen()) {
        <div class="mobile-menu-backdrop" role="presentation" (click)="mobileMenuOpen.set(false)">
          <section class="mobile-menu-sheet" role="dialog" aria-modal="true" aria-label="Дополнительная навигация" (click)="$event.stopPropagation()">
            <div class="sheet-handle"></div>
            <header>
              <div><small>QUESTCONTROL</small><h2>Ещё</h2></div>
              <button type="button" aria-label="Закрыть меню" (click)="mobileMenuOpen.set(false)">×</button>
            </header>
            <div class="mobile-menu-links">
              @if (isAdmin()) {
                <a routerLink="/sessions" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Сессии</b><span>История игр и статистика</span></a>
              }
              <a routerLink="/locations" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Локации</b><span>Площадки и контакты</span></a>
              <a routerLink="/rooms" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Комнаты</b><span>Зоны, игры и устройства</span></a>
              <a routerLink="/users" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Пользователи</b><span>Доступ команды</span></a>
              @if (isAdmin()) {
                <a routerLink="/camera-settings" routerLinkActive="active" (click)="mobileMenuOpen.set(false)"><b>Настройки камер</b><span>Планы и привязка камер</span></a>
              }
            </div>
            <div class="mobile-account-actions">
              <button class="password" (click)="changePassword()">Сменить пароль</button>
              <button class="logout" (click)="logout()">Выйти</button>
            </div>
          </section>
        </div>
      }

      <app-camera-overlay />
    }
  `,
  styles: [`
    .account-actions{position:fixed;z-index:1000;left:24px;bottom:24px;display:grid;width:150px;gap:7px}.account-actions button{width:100%;padding:10px 12px;box-shadow:none}.password{border:1px solid #344054;background:#243047;color:#fff}.logout{border:1px solid #344054;background:#182235;color:#fff}.logout:hover{background:#b42318;border-color:#b42318}
    .mobile-nav,.mobile-menu-backdrop{display:none}
    @media(max-width:760px){
      .account-actions{display:none}
      .mobile-nav{position:fixed;z-index:950;inset:auto 0 0;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;padding:7px 8px calc(7px + env(safe-area-inset-bottom));border-top:1px solid #ffffff1a;background:#101827f7;box-shadow:0 -12px 32px #10182724;backdrop-filter:blur(14px)}
      .mobile-nav a,.mobile-nav>button{display:grid;min-width:0;min-height:52px;place-items:center;align-content:center;gap:3px;padding:5px 3px;border:0;border-radius:10px;background:transparent;box-shadow:none;color:#aeb8ca;text-decoration:none;transform:none}
      .mobile-nav a.active,.mobile-nav>button.active{background:#6674ef24;color:#fff;box-shadow:inset 0 -2px #7c83ff}
      .mobile-nav b{font-size:17px;line-height:1}.mobile-nav span{font-size:10px;font-weight:700;line-height:1.1}
      .mobile-menu-backdrop{position:fixed;z-index:980;inset:0;display:flex;align-items:flex-end;padding-top:60px;background:#10182780;backdrop-filter:blur(4px)}
      .mobile-menu-sheet{width:100%;max-height:calc(100dvh - 54px);overflow:auto;margin:0;padding:8px 16px calc(18px + env(safe-area-inset-bottom));border-radius:22px 22px 0 0;background:#f7f8fb;box-shadow:0 -24px 60px #10182738;animation:sheet-in .18s ease-out}
      .sheet-handle{width:42px;height:4px;margin:2px auto 15px;border-radius:999px;background:#c7ccd6}
      .mobile-menu-sheet>header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
      .mobile-menu-sheet header small{color:#667085;font-size:9px;font-weight:800;letter-spacing:.13em}.mobile-menu-sheet h2{margin:3px 0 0;font-size:26px}.mobile-menu-sheet header button{display:grid;width:42px;height:42px;padding:0;place-items:center;border-radius:50%;background:#e9ecf2;box-shadow:none;color:#344054;font-size:24px}
      .mobile-menu-links{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.mobile-menu-links a{display:grid;align-content:start;min-height:88px;padding:15px;border:1px solid #e0e4eb;border-radius:14px;background:#fff;color:#111827;text-decoration:none}.mobile-menu-links a.active{border-color:#9ba8f7;background:#f0f2ff}.mobile-menu-links b{font-size:14px}.mobile-menu-links span{margin-top:6px;color:#7a8495;font-size:10px;line-height:1.35}
      .mobile-account-actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:16px;padding-top:16px;border-top:1px solid #dfe3e9}.mobile-account-actions button{width:100%;min-height:46px;box-shadow:none}.mobile-account-actions .password{background:#243047}.mobile-account-actions .logout{background:#fff;border-color:#e5b8be;color:#b42336}
      @keyframes sheet-in{from{transform:translateY(24px);opacity:.5}}
    }
    @media(max-width:390px){.mobile-menu-sheet{padding-inline:12px}.mobile-menu-links{grid-template-columns:1fr}.mobile-menu-links a{min-height:70px}}
  `],
})
export class AppComponent {
  private router = inject(Router);
  private http = inject(HttpClient);
  showLogout = signal(this.managementRoute(this.router.url));
  mobileMenuOpen = signal(false);
  currentUrl = signal(this.router.url);
  isAdmin = signal(false);

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

  moreActive() {
    return !["/", "/bookings", "/cameras"].includes(this.currentUrl().split("?")[0]);
  }

  logout() {
    this.mobileMenuOpen.set(false);
    document.body.classList.remove("management-user");
    sessionStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    localStorage.removeItem("questcontrol.selectedCameras");
    void this.router.navigateByUrl("/login");
  }

  private updateManagementClass() {
    try {
      const token = sessionStorage.getItem("access_token");
      const role = token ? JSON.parse(atob(token.split(".")[1])).role : null;
      const admin = role === "OWNER" || role === "ADMIN";
      this.isAdmin.set(admin);
      document.body.classList.toggle("management-user", admin);
    } catch {
      this.isAdmin.set(false);
      document.body.classList.remove("management-user");
    }
  }

  private managementRoute(url: string) {
    return url !== "/login" && !url.startsWith("/reception/checkin");
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
