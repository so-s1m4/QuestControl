import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { HttpClient } from "@angular/common/http";
import { RouterLink } from "@angular/router";

type Role = "OWNER" | "ADMIN" | "OPERATOR" | "TECHNICIAN";
type User = {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  is_active: boolean;
  created_at: string;
  location_ids: string[];
};
type Location = { id:string;name:string };

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
          <a routerLink="/locations">Локации</a>
          <a routerLink="/rooms">Комнаты</a>
          <a routerLink="/cameras">Камеры</a>
          <a routerLink="/krampus">Krampus House</a>
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
              </select>
            </label>
            <label>Временный пароль<input name="password" type="password" [(ngModel)]="draft.password" required minlength="12" autocomplete="new-password"></label>
            <fieldset><legend>Локации</legend>@for(location of locations();track location.id){<label class="check"><input type="checkbox" [checked]="draft.locationIds.includes(location.id)" (change)="toggleDraftLocation(location.id)">{{location.name}}</label>}</fieldset>
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
                <div class="assigned">@for(location of locationsFor(user);track location.id){<span>{{location.name}}</span>}@empty{<span>Нет локаций</span>}</div>
                <span class="status" [class.online]="user.is_active">{{user.is_active ? "Активен" : "Отключён"}}</span>
                <button class="secondary" (click)="editLocations(user)">Локации</button>
                @if(canReset(user)){<button class="secondary" (click)="resetPassword(user)">Пароль</button>}
                <button class="secondary" (click)="toggle(user)">{{user.is_active ? "Отключить" : "Включить"}}</button>
              </article>
            } @empty {
              <div class="empty"><b>Пользователей нет</b></div>
            }
          </div>
        }
      </section>
    </main>
  `,
  styles: [`
    form fieldset{grid-column:1/-1;display:flex;gap:14px;border:1px solid var(--line);border-radius:9px;padding:10px 12px}fieldset .check{display:flex;grid-template-columns:auto 1fr;align-items:center}fieldset input{width:auto}.user-list{display:grid;gap:10px;margin-top:24px}.user-list article{display:grid;grid-template-columns:44px minmax(180px,1fr) 110px minmax(140px,1fr) 90px repeat(3,auto);gap:12px;align-items:center;padding:16px 18px;background:white;border:1px solid #e1e5ed;border-radius:10px}.user-list article.disabled{opacity:.62}.avatar{display:grid;place-items:center;width:42px;height:42px;border-radius:50%;background:#eef0ff;color:#4058df;font-weight:700}.identity strong,.identity span{display:block}.identity span{margin-top:5px;color:#788295}.role{font-weight:600}.assigned{display:flex;flex-wrap:wrap;gap:5px}.assigned span{padding:5px 7px;border-radius:999px;background:#eef4ff;color:#3448a5;font-size:10px}.status{color:#b42318}.status.online{color:#067647}.secondary{background:#eef1f6;color:#344054}.notice{padding:12px 14px;border-radius:8px;background:#ecfdf3;color:#067647}@media(max-width:900px){.user-list article{grid-template-columns:44px 1fr}.role,.assigned,.status,.user-list button{grid-column:2}}
  `]
})
export class UsersComponent {
  private http = inject(HttpClient);
  users = signal<User[]>([]);
  locations = signal<Location[]>([]);
  loading = signal(true);
  saving = signal(false);
  showForm = signal(false);
  error = signal("");
  notice = signal("");
  draft = { displayName: "", email: "", role: "OPERATOR" as Role, password: "", locationIds:[] as string[] };

  constructor() { this.load(); this.http.get<Location[]>("/api/locations").subscribe({next:value=>this.locations.set(value)}); }

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
        this.draft = { displayName: "", email: "", role: "OPERATOR", password: "", locationIds:[] };
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
  locationsFor(user:User){return this.locations().filter(location=>user.location_ids.includes(location.id));}
  editLocations(user:User){
    const names=this.locations().map((location,index)=>`${index+1}: ${location.name}${user.location_ids.includes(location.id)?" ✓":""}`).join("\n");
    const value=prompt(`Введите номера локаций через запятую:\n${names}`,this.locations().map((_,index)=>user.location_ids.includes(this.locations()[index].id)?index+1:null).filter(Boolean).join(","));
    if(value===null)return;
    const locationIds=value.split(",").map(item=>Number(item.trim())-1).filter(index=>index>=0&&index<this.locations().length).map(index=>this.locations()[index].id);
    this.http.put(`/api/users/${user.id}/locations`,{locationIds:[...new Set(locationIds)]}).subscribe({next:()=>this.load(),error:()=>this.error.set("Не удалось обновить локации пользователя.")});
  }
  private token(){try{return JSON.parse(atob((sessionStorage.getItem("access_token")||"").split(".")[1]))}catch{return {}}}
  canReset(user:User){const me=this.token();const rank:Record<string,number>={TECHNICIAN:1,OPERATOR:1,ADMIN:2,OWNER:3};return user.id!==me.sub&&(rank[me.role]||0)>(rank[user.role]||0)}
  resetPassword(user:User){const password=prompt(`Новый пароль для ${user.display_name} (минимум 12 символов):`);if(password===null)return;if(password.length<12){this.error.set("Пароль должен содержать минимум 12 символов.");return}const confirmation=prompt("Повторите новый пароль:");if(confirmation!==password){this.error.set("Пароли не совпадают.");return}this.http.patch(`/api/users/${user.id}/password`,{newPassword:password}).subscribe({next:()=>this.notice.set(`Пароль пользователя ${user.display_name} изменён.`),error:()=>this.error.set("Не удалось изменить пароль пользователя.")})}

  initials(name: string) { return name.trim().split(/\s+/).slice(0, 2).map(part => part[0]?.toUpperCase()).join(""); }
  roleName(role: Role) { return ({ OWNER: "Владелец", ADMIN: "Администратор", OPERATOR: "Оператор", TECHNICIAN: "Техник" })[role]; }
}
