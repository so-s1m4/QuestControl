import { Component, inject, signal } from "@angular/core";
import { RouterOutlet } from "@angular/router";
import { NavigationEnd, Router } from "@angular/router";
import { filter } from "rxjs";

@Component({
  selector:"app-root",
  standalone:true,
  imports:[RouterOutlet],
  template:`<router-outlet/>@if(showLogout()){<button class="logout" (click)="logout()">Выйти</button>}`,
  styles:[`.logout{position:fixed;z-index:1000;left:24px;bottom:24px;width:150px;padding:11px 14px;border:1px solid #344054;background:#182235;color:#fff;box-shadow:none}.logout:hover{background:#b42318;border-color:#b42318}@media(max-width:700px){.logout{position:fixed;left:auto;right:16px;bottom:16px;width:auto}}`]
})
export class AppComponent{
  private router=inject(Router);
  showLogout=signal(this.router.url!=="/login");
  constructor(){this.router.events.pipe(filter((event):event is NavigationEnd=>event instanceof NavigationEnd)).subscribe(event=>this.showLogout.set(event.urlAfterRedirects!=="/login"))}
  logout(){sessionStorage.removeItem("access_token");localStorage.removeItem("refresh_token");localStorage.removeItem("questcontrol.selectedCameras");void this.router.navigateByUrl("/login")}
}
