import { Component, computed, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";

type Location = { id: string; name: string };
type InventoryItem = {
  id: string;
  location_id: string;
  location_name: string;
  name: string;
  category: string;
  unit: string;
  quantity: number | string;
  minimum_quantity: number | string;
  notes: string | null;
  low_stock: boolean;
  updated_at: string;
};

@Component({
  selector: "app-inventory",
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <main>
      <aside>
        <h1>Q <span>QUESTCONTROL</span></h1>
        <nav>
          <a routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a>
          <a class="sessions-nav" routerLink="/sessions">Сессии</a><a routerLink="/locations">Локации</a>
          <a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a>
          <a class="active" routerLink="/inventory">Инвентарь</a><a routerLink="/users">Пользователи</a>
        </nav>
      </aside>

      <section>
        <header>
          <div><h2>Инвентарь</h2><p>Магниты, расходники и минимальные остатки</p></div>
          <button type="button" (click)="formOpen.set(!formOpen())">{{ formOpen() ? "Закрыть" : "+ Добавить позицию" }}</button>
        </header>

        <div class="toolbar">
          <label>Клуб
            <select [ngModel]="locationId()" (ngModelChange)="changeLocation($event)">
              <option value="">Все доступные клубы</option>
              @for (location of locations(); track location.id) { <option [value]="location.id">{{ location.name }}</option> }
            </select>
          </label>
          <button type="button" class="secondary" (click)="load()" [disabled]="loading()">{{ loading() ? "Обновляем…" : "↻ Обновить" }}</button>
        </div>

        @if (formOpen()) {
          <form class="new-item" (ngSubmit)="create()">
            <div class="form-heading"><b>Новая позиция</b><span>Начальный остаток сразу появится у выбранного клуба.</span></div>
            <label>Название *<input name="name" [(ngModel)]="draft.name" placeholder="Например, магнит 50 × 50 мм" required /></label>
            <label>Категория *
              <select name="category" [(ngModel)]="draft.category" required>
                @for (category of categories; track category) { <option [value]="category">{{ category }}</option> }
              </select>
            </label>
            <label>Клуб *
              <select name="locationId" [(ngModel)]="draft.locationId" required>
                <option value="" disabled>Выберите клуб</option>
                @for (location of locations(); track location.id) { <option [value]="location.id">{{ location.name }}</option> }
              </select>
            </label>
            <label>Единица
              <select name="unit" [(ngModel)]="draft.unit">
                @for (unit of units; track unit) { <option [value]="unit">{{ unit }}</option> }
              </select>
            </label>
            <label>Текущий остаток *<input name="quantity" [(ngModel)]="draft.quantity" type="number" min="0" step="0.01" required /></label>
            <label>Минимальный остаток *<input name="minimumQuantity" [(ngModel)]="draft.minimumQuantity" type="number" min="0" step="0.01" required /></label>
            <label class="notes">Комментарий<input name="notes" [(ngModel)]="draft.notes" placeholder="Размер, поставщик или место хранения" /></label>
            <button class="save" [disabled]="saving()">{{ saving() ? "Сохраняем…" : "Добавить" }}</button>
          </form>
        }

        @if (error()) { <p class="error">{{ error() }}</p> }

        <div class="summary">
          <article><span>Позиций</span><b>{{ items().length }}</b></article>
          <article [class.warning]="lowStockCount() > 0"><span>Нужно пополнить</span><b>{{ lowStockCount() }}</b></article>
          <article><span>Магнитов в запасе</span><b>{{ magnetQuantity() }}</b></article>
        </div>

        <div class="inventory-list">
          @for (item of items(); track item.id) {
            <article [class.low]="item.low_stock">
              <div class="item-main">
                <div class="item-title">
                  <span class="category">{{ item.category }}</span>
                  <h3>{{ item.name }}</h3>
                  <p>{{ item.location_name }}@if (item.notes) { · {{ item.notes }} }</p>
                </div>
                <span class="status" [class.ok]="!item.low_stock">{{ item.low_stock ? "Нужно пополнить" : "В наличии" }}</span>
              </div>

              <div class="stock">
                <div><small>Сейчас</small><strong>{{ displayNumber(item.quantity) }} <em>{{ item.unit }}</em></strong></div>
                <div><small>Минимум</small><strong class="minimum">{{ displayNumber(item.minimum_quantity) }} <em>{{ item.unit }}</em></strong></div>
              </div>

              <div class="item-actions">
                <button type="button" class="quick minus" (click)="adjust(item, -1, 'Быстрое списание')" [disabled]="busyId() === item.id || number(item.quantity) < 1">− 1</button>
                <button type="button" class="secondary" (click)="customAdjust(item, -1)" [disabled]="busyId() === item.id">Списать</button>
                <button type="button" class="quick plus" (click)="adjust(item, 1, 'Быстрый приход')" [disabled]="busyId() === item.id">+ 1</button>
                <button type="button" (click)="customAdjust(item, 1)" [disabled]="busyId() === item.id">Приход</button>
              </div>
            </article>
          } @empty {
            @if (!loading()) { <div class="empty"><b>Инвентарь пока пуст</b><span>Добавьте магниты или расходники для нужного клуба.</span></div> }
          }
        </div>
      </section>
    </main>
  `,
  styles: [`
    .toolbar{display:flex;align-items:end;gap:10px;margin:22px 0 0}.toolbar label{width:min(360px,100%)}.secondary{border:1px solid #d7dce5;background:#fff;box-shadow:none;color:#344054}
    .new-item{grid-template-columns:repeat(3,minmax(0,1fr))!important}.form-heading{grid-column:1/-1;display:grid;gap:4px}.form-heading b{font-size:18px}.form-heading span{color:var(--muted);font-size:12px}.notes{grid-column:span 2}.save{min-height:42px;align-self:end}
    .summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;margin:20px 0}.summary article{padding:17px 19px;border:1px solid var(--line);border-radius:14px;background:#fff}.summary span{display:block;color:var(--muted);font-size:11px}.summary b{display:block;margin-top:6px;font-size:25px}.summary .warning{border-color:#f4c7a4;background:#fff8f1}.summary .warning b{color:#c04f18}
    .inventory-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.inventory-list>article{padding:20px;border:1px solid var(--line);border-radius:16px;background:#fff;box-shadow:0 8px 24px #19213a08}.inventory-list>article.low{border-color:#f1bc93;box-shadow:0 8px 24px #d3601710}
    .item-main{display:flex;align-items:start;justify-content:space-between;gap:14px}.category{color:var(--primary);font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.item-title h3{margin:5px 0 4px;font-size:18px}.item-title p{margin:0;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.status{flex:0 0 auto;padding:6px 8px;border-radius:999px;background:#fff0e5;color:#b54708;font-size:9px;font-weight:800}.status.ok{background:#eaf8f1;color:#087443}
    .stock{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:17px 0;padding:14px;border-radius:12px;background:#f5f7fa}.stock small{display:block;color:var(--muted);font-size:10px}.stock strong{display:block;margin-top:4px;font-size:25px}.stock strong.minimum{color:#667085}.stock em{font-size:11px;font-style:normal;font-weight:700}
    .item-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.item-actions button{min-width:0;padding:10px 6px;font-size:11px}.quick{border:1px solid #d7dce5;background:#fff;box-shadow:none;color:#344054}.quick.minus{color:#b42336}.quick.plus{color:#087443}
    @media(max-width:1100px){.inventory-list{grid-template-columns:1fr}.new-item{grid-template-columns:repeat(2,minmax(0,1fr))!important}.notes{grid-column:1/-1}}
    @media(max-width:760px){section{padding-bottom:105px!important}.toolbar{align-items:stretch;flex-direction:column}.toolbar label{width:100%}.toolbar button{width:100%}.new-item{grid-template-columns:1fr!important;padding:16px!important}.new-item>*{grid-column:1!important}.summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.summary article{padding:12px 10px}.summary b{font-size:20px}.inventory-list>article{padding:16px}.item-main{display:grid}.status{justify-self:start}.item-actions{grid-template-columns:1fr 1fr}.item-actions button{min-height:44px;font-size:12px}}
    @media(max-width:390px){.summary{grid-template-columns:1fr}.summary article{display:flex;align-items:center;justify-content:space-between}.summary b{margin:0}}
  `],
})
export class InventoryComponent {
  private http = inject(HttpClient);
  locations = signal<Location[]>([]);
  items = signal<InventoryItem[]>([]);
  locationId = signal("");
  formOpen = signal(false);
  loading = signal(false);
  saving = signal(false);
  busyId = signal("");
  error = signal("");
  categories = ["Магниты", "Батарейки", "Крепёж", "Электроника", "Одноразовые расходники", "Другое"];
  units = ["шт.", "уп.", "м", "л", "кг"];
  draft = { name: "", category: "Магниты", locationId: "", unit: "шт.", quantity: 0, minimumQuantity: 10, notes: "" };

  lowStockCount = computed(() => this.items().filter((item) => item.low_stock).length);
  magnetQuantity = computed(() => this.displayNumber(this.items().filter((item) => /магнит/i.test(item.category)).reduce((total, item) => total + this.number(item.quantity), 0)));

  constructor() {
    this.http.get<Location[]>("/api/locations").subscribe({
      next: (locations) => { this.locations.set(locations); if (locations.length === 1) this.draft.locationId = locations[0].id; },
      error: () => this.error.set("Не удалось загрузить список клубов."),
    });
    this.load();
  }

  number(value: number | string) { return Number(value) || 0; }
  displayNumber(value: number | string) { return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(this.number(value)); }

  changeLocation(value: string) {
    this.locationId.set(value);
    if (value) this.draft.locationId = value;
    this.load();
  }

  load() {
    this.loading.set(true);
    this.error.set("");
    const query = this.locationId() ? `?locationId=${encodeURIComponent(this.locationId())}` : "";
    this.http.get<InventoryItem[]>(`/api/inventory${query}`).subscribe({
      next: (items) => { this.items.set(items); this.loading.set(false); },
      error: () => { this.loading.set(false); this.error.set("Не удалось загрузить инвентарь."); },
    });
  }

  create() {
    if (!this.draft.name.trim() || !this.draft.locationId) { this.error.set("Укажите название и клуб."); return; }
    this.saving.set(true);
    this.error.set("");
    this.http.post("/api/inventory", this.draft).subscribe({
      next: () => {
        const locationId = this.draft.locationId;
        this.draft = { name: "", category: "Магниты", locationId, unit: "шт.", quantity: 0, minimumQuantity: 10, notes: "" };
        this.saving.set(false);
        this.formOpen.set(false);
        this.load();
      },
      error: () => { this.saving.set(false); this.error.set("Не удалось добавить позицию."); },
    });
  }

  adjust(item: InventoryItem, delta: number, reason: string) {
    this.busyId.set(item.id);
    this.error.set("");
    this.http.post(`/api/inventory/${item.id}/adjust`, { delta, reason }).subscribe({
      next: () => { this.busyId.set(""); this.load(); },
      error: ({ error }) => {
        this.busyId.set("");
        this.error.set(error?.error === "INSUFFICIENT_STOCK" ? "Нельзя списать больше, чем есть в наличии." : "Не удалось изменить остаток.");
      },
    });
  }

  customAdjust(item: InventoryItem, direction: 1 | -1) {
    const raw = prompt(direction > 0 ? `Сколько ${item.unit} добавить?` : `Сколько ${item.unit} списать?`, "1");
    if (raw === null) return;
    const amount = Number(raw.replace(",", "."));
    if (!Number.isFinite(amount) || amount <= 0) { alert("Введите положительное число."); return; }
    const reason = prompt(direction > 0 ? "Причина прихода:" : "Причина списания:", direction > 0 ? "Поставка" : "Использовано")?.trim();
    if (!reason) return;
    this.adjust(item, amount * direction, reason);
  }
}
