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
import { adminGuard, workTimeGuard } from "./core/admin.guard";
import { ReceptionCheckinComponent } from "./pages/reception-checkin/reception-checkin.component";
import { InventoryComponent } from "./pages/inventory/inventory.component";
import { CameraWatchComponent } from "./pages/camera-watch/camera-watch.component";
import { RoomControlComponent } from "./pages/room-control/room-control.component";
import { WorkSchedulesComponent } from "./pages/work-schedules/work-schedules.component";
import { IntegrationsComponent } from "./pages/integrations/integrations.component";
import { TelegramComponent } from "./pages/telegram/telegram.component";
export const routes: Routes = [
  { path: "login", component: LoginComponent },
  { path: "reception/checkin/:token", component: ReceptionCheckinComponent },
  { path: "reception/checkin", component: ReceptionCheckinComponent },
  { path: "watch/:token", component: CameraWatchComponent },
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
  { path: "work-schedules", component: WorkSchedulesComponent, canActivate: [authGuard, workTimeGuard] },
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
  { path: "rooms/:id/control", component: RoomControlComponent, canActivate: [authGuard] },
  { path: "inventory", component: InventoryComponent, canActivate: [authGuard] },
  { path: "telegram", component: TelegramComponent, canActivate: [authGuard] },
  { path: "integrations", component: IntegrationsComponent, canActivate: [authGuard, adminGuard] },
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
