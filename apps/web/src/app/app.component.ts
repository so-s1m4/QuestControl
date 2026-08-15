import { Component, inject, signal } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { NavigationEnd, Router } from "@angular/router";
import { filter } from "rxjs";
import { CameraOverlayComponent } from "./core/camera-overlay.component";
import { HttpClient } from "@angular/common/http";

@Component({
  selector:"app-root",
  standalone:true,
  imports:[RouterOutlet,CameraOverlayComponent],
  template:`<router-outlet/>@if(showLogout()){<div class="account-actions" [class.open]="accountOpen()"><button class="account-toggle" type="button" aria-label="Меню аккаунта" [attr.aria-expanded]="accountOpen()" (click)="accountOpen.set(!accountOpen())">{{accountOpen()?"×":"•••"}}</button><div class="account-menu"><button class="password" (click)="changePassword()">Сменить пароль</button><button class="logout" (click)="logout()">Выйти</button></div></div><app-camera-overlay/>}`,
  styles:[`.account-actions{position:fixed;z-index:1000;left:24px;bottom:24px;width:150px}.account-menu{display:grid;gap:7px}.account-actions button{width:100%;padding:10px 12px;box-shadow:none}.account-toggle{display:none}.password{border:1px solid #344054;background:#243047;color:#fff}.logout{border:1px solid #344054;background:#182235;color:#fff}.logout:hover{background:#b42318;border-color:#b42318}@media(max-width:760px){.account-actions{left:auto;right:12px;bottom:calc(100px + env(safe-area-inset-bottom));width:auto}.account-toggle{display:grid;width:42px!important;height:42px;padding:0!important;place-items:center;border:1px solid #344054;border-radius:50%;background:#182235;color:#fff;box-shadow:0 8px 24px #10182740}.account-menu{position:absolute;right:0;bottom:50px;display:none;width:165px;padding:8px;border:1px solid #344054;border-radius:12px;background:#101827;box-shadow:0 14px 35px #10182755}.account-actions.open .account-menu{display:grid}}`]
})
export class AppComponent{
  private router=inject(Router);
  private http=inject(HttpClient);
  showLogout=signal(this.managementRoute(this.router.url));
  accountOpen=signal(false);
  constructor(){this.updateManagementClass();this.router.events.pipe(filter((event):event is NavigationEnd=>event instanceof NavigationEnd)).subscribe(event=>{this.showLogout.set(this.managementRoute(event.urlAfterRedirects));this.updateManagementClass();})}
  logout(){document.body.classList.remove("management-user");sessionStorage.removeItem("access_token");localStorage.removeItem("refresh_token");localStorage.removeItem("questcontrol.selectedCameras");void this.router.navigateByUrl("/login")}
  private updateManagementClass(){try{const token=sessionStorage.getItem("access_token");const role=token?JSON.parse(atob(token.split(".")[1])).role:null;document.body.classList.toggle("management-user",role==="OWNER"||role==="ADMIN");}catch{document.body.classList.remove("management-user");}}
  private managementRoute(url:string){return url!=="/login"&&!url.startsWith("/reception/checkin")}
  changePassword(){const currentPassword=prompt("Введите текущий пароль:");if(currentPassword===null)return;const newPassword=prompt("Введите новый пароль (минимум 12 символов):");if(newPassword===null)return;if(newPassword.length<12){alert("Новый пароль должен содержать минимум 12 символов.");return}const confirmation=prompt("Повторите новый пароль:");if(confirmation!==newPassword){alert("Пароли не совпадают.");return}this.http.patch("/api/auth/password",{currentPassword,newPassword}).subscribe({next:()=>{alert("Пароль изменён. Войдите заново.");this.logout()},error:({error})=>alert(error?.error==="CURRENT_PASSWORD_INVALID"?"Текущий пароль указан неверно.":"Не удалось изменить пароль.")})}
}
