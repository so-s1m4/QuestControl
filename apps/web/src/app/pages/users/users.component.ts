import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";

type Role = "OWNER" | "ADMIN" | "OPERATOR" | "TECHNICIAN" | "CAMERA_VIEWER";
type User = {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  location_ids: string[];
  camera_ids: string[];
};
type Location = { id:string;name:string };
type Camera = {id:string;name:string;location_id:string;room_name?:string};

@Component({
  selector: "app-users",
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <main>
      <aside>
        <h1>Q <span>QUESTCONTROL</span></h1>
        <nav>
          <a routerLink="/">Обзор</a>
          <a routerLink="/bookings">Бронирования</a>
          <a class="sessions-nav" routerLink="/sessions">Сессии</a>
          <a routerLink="/locations">Локации</a>
          <a routerLink="/rooms">Комнаты</a>
          <a routerLink="/cameras">Камеры</a>
          <a routerLink="/inventory">Инвентарь</a>
          <a class="active" routerLink="/users">Пользователи</a>
        </nav>
      </aside>
      <section>
        <header>
          <div><h2>Пользователи</h2><p>Доступ команды к QuestControl</p></div>
          <button (click)="showForm.set(!showForm())">{{showForm() ? "Закрыть" : "+ Добавить пользователя"}}</button>
        </header>

        @if (showForm()) {
          <form (ngSubmit)="create()">
            <label>Имя<input name="displayName" [(ngModel)]="draft.displayName" required minlength="2" autocomplete="name"></label>
            <label>Email<input name="email" type="email" [(ngModel)]="draft.email" required autocomplete="off"></label>
            <label>Роль
              <select name="role" [(ngModel)]="draft.role">
                <option value="OPERATOR">Оператор</option>
                <option value="TECHNICIAN">Техник</option>
                <option value="ADMIN">Администратор</option>
                <option value="OWNER">Владелец</option>
                <option value="CAMERA_VIEWER">Только камеры</option>
              </select>
            </label>
            <label>Временный пароль<input name="password" type="password" [(ngModel)]="draft.password" required minlength="12" autocomplete="new-password"></label>
            @if(draft.role==="CAMERA_VIEWER"){
              <fieldset><legend>Разрешённые камеры</legend>@for(camera of cameras();track camera.id){<label class="check"><input type="checkbox" [checked]="draft.cameraIds.includes(camera.id)" (change)="toggleDraftCamera(camera.id)">{{camera.name}} <small>{{locationName(camera.location_id)}}</small></label>}@empty{<span>Камер пока нет</span>}</fieldset>
            } @else {
              <fieldset><legend>Локации</legend>@for(location of locations();track location.id){<label class="check"><input type="checkbox" [checked]="draft.locationIds.includes(location.id)" (change)="toggleDraftLocation(location.id)">{{location.name}}</label>}</fieldset>
            }
            <button type="submit" [disabled]="saving()">{{saving() ? "Создаём…" : "Создать"}}</button>
            <p class="hint">Минимум 12 символов. Передайте пароль пользователю безопасным способом.</p>
          </form>
        }

        @if (error()) { <p class="error">{{error()}}</p> }
        @if (notice()) { <p class="notice">{{notice()}}</p> }
        @if (loading()) { <p>Загрузка пользователей…</p> }
        @else {
          <div class="user-list">
            @for (user of users(); track user.id) {
              <article [class.disabled]="!user.is_active">
                <div class="avatar">{{initials(user.display_name)}}</div>
                <div class="identity">
                  <strong>{{user.display_name}}</strong>
                  <span>{{user.email}}</span>
                </div>
                <span class="role">{{roleName(user.role)}}</span>
                <div class="assigned">@if(user.role==="CAMERA_VIEWER"){<span>{{user.camera_ids.length}} камер</span>}@else{@for(location of locationsFor(user);track location.id){<span>{{location.name}}</span>}@empty{<span>Нет локаций</span>}}</div>
                <span class="status" [class.online]="user.is_active">{{user.is_active ? "Активен" : "Отключён"}}</span>
                @if(isOwner()) {<button class="secondary" (click)="openSettings(user)">Настроить</button>}
                @else if(user.role==="CAMERA_VIEWER"){<button class="secondary" (click)="editCameras(user)">Камеры</button>}@else{<button class="secondary" (click)="editLocations(user)">Локации</button>}
              </article>
            } @empty {
              <div class="empty"><b>Пользователей нет</b></div>
            }
          </div>
        }
      </section>
    </main>
    @if(settingsUser()) {
      <div class="modal-backdrop" (click)="closeSettings()">
        <section class="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" (click)="$event.stopPropagation()">
          <header><div><h3 id="settings-title">Настройки пользователя</h3><p>{{settingsUser()!.email}}</p></div><button class="close" type="button" aria-label="Закрыть" (click)="closeSettings()">×</button></header>
          <form class="settings-form" (ngSubmit)="saveSettings()">
            <label>Имя<input name="editDisplayName" [(ngModel)]="editDraft.displayName" required minlength="2" autocomplete="name"></label>
            <label>Роль<select name="editRole" [(ngModel)]="editDraft.role"><option value="OPERATOR">Оператор</option><option value="TECHNICIAN">Техник</option><option value="ADMIN">Администратор</option><option value="OWNER">Владелец</option><option value="CAMERA_VIEWER">Только камеры</option></select></label>
            <fieldset class="location-picker"><legend>Доступные локации</legend>@for(location of locations();track location.id){<label class="location-check"><input type="checkbox" [checked]="editDraft.locationIds.includes(location.id)" (change)="toggleEditLocation(location.id)"><span>{{location.name}}</span></label>}@empty{<span>Локаций пока нет</span>}</fieldset>
            <div class="password-block"><label>Новый пароль <small>Оставьте пустым, если менять не нужно</small><input name="editPassword" type="password" [(ngModel)]="editDraft.password" minlength="12" autocomplete="new-password" placeholder="Минимум 12 символов"></label><label>Повторите пароль<input name="editPasswordConfirm" type="password" [(ngModel)]="editDraft.passwordConfirm" autocomplete="new-password" [required]="!!editDraft.password"></label></div>
            <label class="account-toggle"><input name="editActive" type="checkbox" [(ngModel)]="editDraft.isActive"><span><b>Аккаунт активен</b><small>Если отключить, пользователь больше не сможет войти</small></span></label>
            @if(settingsError()){<p class="error">{{settingsError()}}</p>}
            <div class="danger-zone"><button type="button" class="delete" [disabled]="settingsSaving()||settingsUser()!.id===token().sub" (click)="deleteUser()">Удалить аккаунт</button><small>Рабочая история сохранится</small></div>
            <footer><button type="button" class="secondary" (click)="closeSettings()">Отмена</button><button type="submit" [disabled]="settingsSaving()">{{settingsSaving()?"Сохраняем…":"Сохранить"}}</button></footer>
          </form>
        </section>
      </div>
    }
  `,
  styles: [`
    .user-list article{grid-template-columns:44px minmax(180px,1fr) 110px minmax(140px,1fr) 90px auto!important}.settings-modal{width:min(560px,100%);max-height:calc(100vh - 40px);overflow:auto!important}.location-picker{display:flex!important;flex-wrap:wrap}.location-check{display:flex!important;align-items:center;gap:7px!important;padding:8px 10px;border-radius:9px;background:#f5f7fa;font-weight:500!important}.location-check input,.account-toggle input{width:auto}.account-toggle{grid-column:1/-1;display:flex!important;align-items:flex-start;gap:10px!important;padding:12px;border-radius:10px;background:#f5f7fa}.account-toggle span{display:grid;gap:3px}.danger-zone{grid-column:1/-1;display:flex;align-items:center;gap:10px;padding-top:8px;border-top:1px solid #eaecf0}.danger-zone .delete{background:#fff1f2;color:#b42318;box-shadow:none}.danger-zone small{color:#98a2b3}
    form fieldset{grid-column:1/-1;display:flex;gap:14px;border:1px solid var(--line);border-radius:9px;padding:10px 12px}fieldset .check{display:flex;grid-template-columns:auto 1fr;align-items:center}fieldset input{width:auto}.user-list{display:grid;gap:10px;margin-top:24px}.user-list article{display:grid;grid-template-columns:44px minmax(180px,1fr) 110px minmax(140px,1fr) 90px repeat(2,auto);gap:12px;align-items:center;padding:16px 18px;background:white;border:1px solid #e1e5ed;border-radius:10px}.user-list article.disabled{opacity:.62}.avatar{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:#eef0ff;color:#4058df;font-weight:700}.identity{min-width:0}.identity strong,.identity span{display:block;overflow-wrap:anywhere}.identity span{margin-top:5px;color:#788295}.role{font-weight:600}.assigned{display:flex;flex-wrap:wrap;gap:5px}.assigned span{padding:5px 7px;border-radius:999px;background:#eef4ff;color:#3448a5;font-size:10px}.status{color:#b42318}.status.online{color:#067647}.secondary{background:#eef1f6;color:#344054}.notice{padding:12px 14px;border-radius:8px;background:#ecfdf3;color:#067647}.modal-backdrop{position:fixed;z-index:2000;inset:0;display:grid;place-items:center;padding:20px;background:rgba(15,23,42,.5);backdrop-filter:blur(3px)}.settings-modal{width:min(520px,100%);overflow:hidden;border-radius:18px;background:#fff;box-shadow:0 24px 70px rgba(15,23,42,.24)}.settings-modal>header{display:flex;align-items:flex-start;justify-content:space-between;padding:24px 26px 18px;border-bottom:1px solid #eaecf0}.settings-modal h3{margin:0;font-size:21px}.settings-modal header p{margin:5px 0 0;color:#667085}.close{padding:0;width:36px;height:36px;border-radius:50%;background:#f2f4f7;color:#475467;font-size:24px;line-height:1}.settings-form{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:24px 26px}.settings-form label{display:grid;gap:7px;font-weight:600}.settings-form label small{display:block;color:#98a2b3;font-weight:400}.password-block{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:16px;padding-top:4px}.settings-form .error{grid-column:1/-1;margin:0}.settings-form footer{grid-column:1/-1;display:flex;justify-content:flex-end;gap:10px;margin-top:4px}.settings-form footer button{min-width:120px}@media(max-width:900px){.user-list article{grid-template-columns:44px 1fr}.role,.assigned,.status,.user-list button{grid-column:2}}@media(max-width:600px){form fieldset{align-items:stretch;flex-direction:column}.user-list article{padding:15px 14px}.user-list button{width:100%;min-height:42px}.settings-form,.password-block{grid-template-columns:1fr}.settings-modal>header,.settings-form{padding-left:18px;padding-right:18px}}
  `]
})
export class UsersComponent {
  private http = inject(HttpClient);
  users = signal<User[]>([]);
  locations = signal<Location[]>([]);
  cameras = signal<Camera[]>([]);
  loading = signal(true);
  saving = signal(false);
  showForm = signal(false);
  error = signal("");
  notice = signal("");
  settingsUser = signal<User|null>(null);
  settingsSaving = signal(false);
  settingsError = signal("");
  editDraft = { displayName:"", role:"OPERATOR" as Role, password:"", passwordConfirm:"", isActive:true, locationIds:[] as string[] };
  draft = { displayName: "", email: "", role: "OPERATOR" as Role, password: "", locationIds:[] as string[], cameraIds:[] as string[] };

  constructor() { this.load(); this.http.get<Location[]>("/api/locations").subscribe({next:value=>this.locations.set(value)}); this.http.get<Camera[]>("/api/cameras").subscribe({next:value=>this.cameras.set(value)}); }

  load() {
    this.loading.set(true);
    this.http.get<User[]>("/api/users").subscribe({
      next: users => { this.users.set(users); this.loading.set(false); },
      error: ({ status }) => {
        this.error.set(status === 403 ? "Управлять пользователями может только владелец." : "Не удалось загрузить пользователей.");
        this.loading.set(false);
      }
    });
  }

  create() {
    this.saving.set(true);
    this.error.set("");
    this.notice.set("");
    this.http.post<User>("/api/users", this.draft).subscribe({
      next: user => {
        this.notice.set(`Пользователь ${user.email} создан.`);
        this.draft = { displayName: "", email: "", role: "OPERATOR", password: "", locationIds:[], cameraIds:[] };
        this.saving.set(false);
        this.showForm.set(false);
        this.load();
      },
      error: ({ status }) => {
        this.error.set(status === 409 ? "Пользователь с таким email уже существует." : "Не удалось создать пользователя. Проверьте поля и длину пароля.");
        this.saving.set(false);
      }
    });
  }

  toggle(user: User) {
    this.error.set("");
    this.http.patch(`/api/users/${user.id}/status`, { isActive: !user.is_active }).subscribe({
      next: () => this.load(),
      error: ({ status }) => this.error.set(status === 409 ? "Нельзя отключить собственный аккаунт." : "Не удалось изменить статус пользователя.")
    });
  }
  toggleDraftLocation(id:string){this.draft.locationIds=this.draft.locationIds.includes(id)?this.draft.locationIds.filter(value=>value!==id):[...this.draft.locationIds,id];}
  toggleDraftCamera(id:string){this.draft.cameraIds=this.draft.cameraIds.includes(id)?this.draft.cameraIds.filter(value=>value!==id):[...this.draft.cameraIds,id];}
  locationName(id:string){return this.locations().find(location=>location.id===id)?.name||"Без локации"}
  locationsFor(user:User){return this.locations().filter(location=>user.location_ids.includes(location.id));}
  editLocations(user:User){
    const names=this.locations().map((location,index)=>`${index+1}: ${location.name}${user.location_ids.includes(location.id)?" ✓":""}`).join("\n");
    const value=prompt(`Введите номера локаций через запятую:\n${names}`,this.locations().map((_,index)=>user.location_ids.includes(this.locations()[index].id)?index+1:null).filter(Boolean).join(","));
    if(value===null)return;
    const locationIds=value.split(",").map(item=>Number(item.trim())-1).filter(index=>index>=0&&index<this.locations().length).map(index=>this.locations()[index].id);
    this.http.put(`/api/users/${user.id}/locations`,{locationIds:[...new Set(locationIds)]}).subscribe({next:()=>this.load(),error:()=>this.error.set("Не удалось обновить локации пользователя.")});
  }
  editCameras(user:User){
    const items=this.cameras().map((camera,index)=>`${index+1}: ${camera.name} — ${this.locationName(camera.location_id)}${user.camera_ids.includes(camera.id)?" ✓":""}`).join("\n");
    const selected=this.cameras().map((camera,index)=>user.camera_ids.includes(camera.id)?index+1:null).filter(Boolean).join(",");
    const value=prompt(`Введите номера доступных камер через запятую. Чтобы отозвать весь доступ, оставьте поле пустым:\n${items}`,selected);
    if(value===null)return;
    const cameraIds=[...new Set(value.split(",").map(item=>Number(item.trim())-1).filter(index=>index>=0&&index<this.cameras().length).map(index=>this.cameras()[index].id))];
    this.http.put(`/api/users/${user.id}/cameras`,{cameraIds}).subscribe({next:()=>{this.notice.set("Доступ к камерам обновлён.");this.load()},error:()=>this.error.set("Не удалось обновить доступ к камерам.")});
  }
  token(){try{return JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1]))}catch{return {}}}
  isOwner(){return this.token().role==="OWNER"}
  openSettings(user:User){this.settingsUser.set(user);this.settingsError.set("");this.editDraft={displayName:user.display_name,role:user.role,password:"",passwordConfirm:"",isActive:user.is_active,locationIds:[...user.location_ids]}}
  toggleEditLocation(id:string){this.editDraft.locationIds=this.editDraft.locationIds.includes(id)?this.editDraft.locationIds.filter(value=>value!==id):[...this.editDraft.locationIds,id]}
  closeSettings(){if(!this.settingsSaving())this.settingsUser.set(null)}
  saveSettings(){
    const user=this.settingsUser();if(!user)return;
    this.settingsError.set("");
    if(this.editDraft.displayName.trim().length<2){this.settingsError.set("Введите имя пользователя.");return}
    if(this.editDraft.password&&this.editDraft.password.length<12){this.settingsError.set("Пароль должен содержать минимум 12 символов.");return}
    if(this.editDraft.password!==this.editDraft.passwordConfirm){this.settingsError.set("Пароли не совпадают.");return}
    this.settingsSaving.set(true);
    const body:{displayName:string;role:Role;isActive:boolean;locationIds:string[];newPassword?:string}={displayName:this.editDraft.displayName.trim(),role:this.editDraft.role,isActive:this.editDraft.isActive,locationIds:this.editDraft.locationIds};
    if(this.editDraft.password)body.newPassword=this.editDraft.password;
    this.http.patch<User>(`/api/users/${user.id}`,body).subscribe({next:()=>{this.settingsSaving.set(false);this.settingsUser.set(null);this.notice.set("Настройки пользователя сохранены.");this.load()},error:({status,error})=>{this.settingsSaving.set(false);this.settingsError.set(status===409&&error?.error==="LAST_OWNER"?"Нельзя изменить роль последнего активного владельца.":"Не удалось сохранить настройки.")}})
  }
  deleteUser(){
    const user=this.settingsUser();if(!user||user.id===this.token().sub)return;
    if(!confirm(`Удалить аккаунт ${user.display_name}? Войти в него больше не получится.`))return;
    this.settingsSaving.set(true);this.settingsError.set("");
    this.http.delete(`/api/users/${user.id}`).subscribe({next:()=>{this.settingsSaving.set(false);this.settingsUser.set(null);this.notice.set("Аккаунт удалён. Рабочая история сохранена.");this.load()},error:({status,error})=>{this.settingsSaving.set(false);this.settingsError.set(status===409&&error?.error==="LAST_OWNER"?"Нельзя удалить последнего активного владельца.":"Не удалось удалить аккаунт.")}})
  }

  initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join(""); }
  roleName(role: Role) { return ({ OWNER: "Владелец", ADMIN: "Администратор", OPERATOR: "Оператор", TECHNICIAN: "Техник", CAMERA_VIEWER:"Только камеры" })[role]; }
}
