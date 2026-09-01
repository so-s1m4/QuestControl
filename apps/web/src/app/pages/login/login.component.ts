import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { Router } from "@angular/router";

@Component({
  selector: "app-login",
  standalone: true,
  imports: [FormsModule],
  styles: [`
    .login-page{min-height:100vh;display:grid;place-items:center;background:#111827}
    .login-card{display:grid;grid-template-columns:1fr;width:min(420px,calc(100% - 32px));margin:0;padding:32px;align-items:stretch}
    h1{margin:0;color:#8290ff}h1 span{font-size:13px;letter-spacing:2px;color:#151c2b}
    h2{margin:18px 0 8px}.error{margin:0}button{margin-top:4px}
  `],
  template: `
    <div class="login-page">
      <form class="login-card" (ngSubmit)="login()">
        <h1>Q <span>QUESTCONTROL</span></h1>
        <h2>Вход</h2>
        <label>Email<input name="email" type="email" autocomplete="username" [(ngModel)]="email" required></label>
        <label>Пароль<input name="password" type="password" autocomplete="current-password" [(ngModel)]="password" required minlength="8"></label>
        @if(error()){<p class="error">{{error()}}</p>}
        <button type="submit" [disabled]="loading()">{{loading() ? "Входим…" : "Войти"}}</button>
      </form>
    </div>
  `
})
export class LoginComponent {
  private http = inject(HttpClient);
  private router = inject(Router);
  email = "";
  password = "";
  loading = signal(false);
  error = signal("");

  login() {
    this.loading.set(true);
    this.error.set("");
    this.http.post<{accessToken:string;refreshToken:string}>("/api/auth/login", {email:this.email,password:this.password}).subscribe({
      next: result => {
        sessionStorage.setItem("access_token", result.accessToken);
        localStorage.setItem("refresh_token", result.refreshToken);
        let destination="/";try{if(JSON.parse(atob(result.accessToken.split(".")[1])).role==="CAMERA_VIEWER")destination="/cameras"}catch{}
        this.router.navigateByUrl(destination);
      },
      error: () => { this.error.set("Неверный email или пароль."); this.loading.set(false); }
    });
  }
}
