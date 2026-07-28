import { Routes } from "@angular/router";
import { OverviewComponent } from "./pages/overview/overview.component";
import { CamerasComponent } from "./pages/cameras/cameras.component";
import { LoginComponent } from "./pages/login/login.component";
import { authGuard } from "./core/auth.guard";
import { KrampusComponent } from "./pages/krampus/krampus.component";
import { UsersComponent } from "./pages/users/users.component";
export const routes:Routes=[
  {path:"login",component:LoginComponent},
  {path:"",component:OverviewComponent,canActivate:[authGuard]},
  {path:"cameras",component:CamerasComponent,canActivate:[authGuard]},
  {path:"krampus",component:KrampusComponent,canActivate:[authGuard]},
  {path:"users",component:UsersComponent,canActivate:[authGuard]},
  {path:"**",redirectTo:""}
];
