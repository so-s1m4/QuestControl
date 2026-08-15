import { Routes } from "@angular/router";
import { OverviewComponent } from "./pages/overview/overview.component";
import { CamerasComponent } from "./pages/cameras/cameras.component";
import { LoginComponent } from "./pages/login/login.component";
import { authGuard } from "./core/auth.guard";
import { KrampusComponent } from "./pages/krampus/krampus.component";
import { UsersComponent } from "./pages/users/users.component";
import { BookingsComponent } from "./pages/bookings/bookings.component";
import { RoomsComponent } from "./pages/rooms/rooms.component";
import { LocationsComponent } from "./pages/locations/locations.component";
import { CameraSettingsComponent } from "./pages/camera-settings/camera-settings.component";
import { SessionsComponent } from "./pages/sessions/sessions.component";
import { VrPoeltenComponent } from "./pages/vr-poelten/vr-poelten.component";
import { VrSessionLogsComponent } from "./pages/vr-session-logs/vr-session-logs.component";
import { adminGuard } from "./core/admin.guard";
import { ReceptionCheckinComponent } from "./pages/reception-checkin/reception-checkin.component";
import { InventoryComponent } from "./pages/inventory/inventory.component";
export const routes: Routes = [
  { path: "login", component: LoginComponent },
  { path: "reception/checkin/:token", component: ReceptionCheckinComponent },
  { path: "reception/checkin", component: ReceptionCheckinComponent },
  { path: "", component: OverviewComponent, canActivate: [authGuard] },
  { path: "cameras", component: CamerasComponent, canActivate: [authGuard] },
  {
    path: "camera-settings",
    component: CameraSettingsComponent,
    canActivate: [authGuard],
  },
  { path: "krampus", component: KrampusComponent, canActivate: [authGuard] },
  { path: "users", component: UsersComponent, canActivate: [authGuard] },
  { path: "bookings", component: BookingsComponent, canActivate: [authGuard] },
  {
    path: "sessions",
    component: SessionsComponent,
    canActivate: [authGuard, adminGuard],
  },
  {
    path: "locations",
    component: LocationsComponent,
    canActivate: [authGuard],
  },
  { path: "rooms", component: RoomsComponent, canActivate: [authGuard] },
  { path: "inventory", component: InventoryComponent, canActivate: [authGuard] },
  {
    path: "vr-sankt-poelten/logs",
    component: VrSessionLogsComponent,
    canActivate: [authGuard],
  },
  {
    path: "vr-sankt-poelten",
    component: VrPoeltenComponent,
    canActivate: [authGuard],
  },
  { path: "**", redirectTo: "" },
];
