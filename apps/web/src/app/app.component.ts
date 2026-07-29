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
  template:`<router-outlet/>@if(showLogout()){<div class="account-actions"><button class="password" (click)="changePassword()">Сменить пароль</button><button class="logout" (click)="logout()">Выйти</button></div><app-camera-overlay/>}`,
  styles:[`.account-actions{position:fixed;z-index:1000;left:24px;bottom:24px;display:grid;width:150px;gap:7px}.account-actions button{width:100%;padding:10px 12px;box-shadow:none}.password{border:1px solid #344054;background:#243047;color:#fff}.logout{border:1px solid #344054;background:#182235;color:#fff}.logout:hover{background:#b42318;border-color:#b42318}@media(max-width:700px){.account-actions{left:auto;right:16px;bottom:16px;width:150px}}`]
})
export class AppComponent{
  private router=inject(Router);
  private http=inject(HttpClient);
  showLogout=signal(this.router.url!=="/login");
  constructor(){this.updateManagementClass();this.router.events.pipe(filter((event):event is NavigationEnd=>event instanceof NavigationEnd)).subscribe(event=>{this.showLogout.set(event.urlAfterRedirects!=="/login");this.updateManagementClass();})}
  logout(){document.body.classList.remove("management-user");sessionStorage.removeItem("access_token");localStorage.removeItem("refresh_token");localStorage.removeItem("questcontrol.selectedCameras");void this.router.navigateByUrl("/login")}
  private updateManagementClass(){try{const token=sessionStorage.getItem("access_token");const role=token?JSON.parse(atob(token.split(".")[1])).role:null;document.body.classList.toggle("management-user",role==="OWNER"||role==="ADMIN");}catch{document.body.classList.remove("management-user");}}
  changePassword(){const currentPassword=prompt("Введите текущий пароль:");if(currentPassword===null)return;const newPassword=prompt("Введите новый пароль (минимум 12 символов):");if(newPassword===null)return;if(newPassword.length<12){alert("Новый пароль должен содержать минимум 12 символов.");return}const confirmation=prompt("Повторите новый пароль:");if(confirmation!==newPassword){alert("Пароли не совпадают.");return}this.http.patch("/api/auth/password",{currentPassword,newPassword}).subscribe({next:()=>{alert("Пароль изменён. Войдите заново.");this.logout()},error:({error})=>alert(error?.error==="CURRENT_PASSWORD_INVALID"?"Текущий пароль указан неверно.":"Не удалось изменить пароль.")})}
}
