import { Component, computed, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { buildInventoryPdf, type InventoryPdfItem } from "./inventory-pdf";

type Location = { id: string; name: string };
type Game={id:string;name:string;location_id:string};
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
  created_at: string;
  updated_at: string;
  game_id:string|null;
};
type InventoryMovement = {
  id: string;
  delta: number | string;
  quantity_after: number | string;
  reason: string;
  operation_count: number;
  created_at: string;
  last_event_at: string;
  created_by_name: string;
};
type InventoryHistoryItem = {
  id: string;
  name: string;
  unit: string;
  created_at: string;
  initial_quantity: number | string;
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
          <label class="club-filter">Клуб
            <select [ngModel]="locationId()" (ngModelChange)="changeLocation($event)">
              <option value="">Все</option>
              @for (location of locations(); track location.id) { <option [value]="location.id">{{ location.name }}</option> }
            </select>
          </label>
          <label class="search-filter">Поиск по названию
            <input type="search" [ngModel]="search()" (ngModelChange)="search.set($event)" placeholder="Например, магнит 50 × 50" />
          </label>
          <label class="category-filter">Категория
            <select [ngModel]="categoryFilter()" (ngModelChange)="categoryFilter.set($event)">
              <option value="">Все</option>
              @for (category of categoryOptions(); track category) { <option [value]="category">{{ category }}</option> }
            </select>
          </label>
          @if (filtersActive()) {
            <button type="button" class="clear-filters" (click)="clearFilters()">Сбросить</button>
          }
          <button type="button" class="secondary" (click)="load()" [disabled]="loading()">{{ loading() ? "Обновляем…" : "↻ Обновить" }}</button>
          <button type="button" class="export" (click)="exportPdf()" [disabled]="exportingPdf() || loading() || !filteredItems().length">{{ exportingPdf() ? "Готовим PDF…" : "↓ Экспорт PDF" }}</button>
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
            @if(draft.category==='Магниты'){<label>Для игры<select name="gameId" [(ngModel)]="draft.gameId"><option value="">Универсальный магнит</option>@for(game of gamesForLocation(draft.locationId);track game.id){<option [value]="game.id">{{game.name}}</option>}</select></label>}
            <label class="notes">Комментарий<input name="notes" [(ngModel)]="draft.notes" placeholder="Размер, поставщик или место хранения" /></label>
            <button class="save" [disabled]="saving()">{{ saving() ? "Сохраняем…" : "Добавить" }}</button>
          </form>
        }

        @if (error()) { <p class="error">{{ error() }}</p> }

        <div class="summary">
          <article><span>{{ filtersActive() ? "Найдено позиций" : "Позиций" }}</span><b>{{ filteredItems().length }}</b></article>
          <article [class.warning]="lowStockCount() > 0"><span>Нужно пополнить</span><b>{{ lowStockCount() }}</b></article>
          <article><span>Магнитов в запасе</span><b>{{ magnetQuantity() }}</b></article>
        </div>

        <div class="category-groups">
          @for (group of categoryGroups(); track group.category) {
            <section class="category-group">
              <div class="category-heading"><h3>{{ group.category }}</h3><span>{{ group.items.length }} поз.</span></div>
              <div class="inventory-list">
          @for (item of group.items; track item.id) {
            <article [class.low]="item.low_stock">
              <div class="item-main">
                <div class="item-title">
                  <span class="category">{{ item.category }}</span>
                  <h3>{{ item.name }}</h3>
                  <p>{{ item.location_name }}@if (item.notes) { · {{ item.notes }} }</p>
                  <small class="added-at">Добавлено {{ formatDate(item.created_at) }}</small>
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
              <div class="item-management">
                @if(item.category==='Магниты'){<label>Игра<select [ngModel]="item.game_id||''" (ngModelChange)="changeGame(item,$event)" [disabled]="busyId()===item.id"><option value="">Универсальный</option>@for(game of gamesForLocation(item.location_id);track game.id){<option [value]="game.id">{{game.name}}</option>}</select></label>}
                <button type="button" class="minimum-edit" (click)="changeMinimum(item)" [disabled]="busyId() === item.id">Изменить минимум</button>
                <button type="button" class="remove-item" (click)="removeItem(item)" [disabled]="busyId() === item.id">Удалить позицию</button>
              </div>
              <button type="button" class="history-toggle" [class.open]="historyItemId() === item.id" (click)="toggleHistory(item)">
                <span>История прихода и списаний</span><b>{{ historyItemId() === item.id ? "⌃" : "⌄" }}</b>
              </button>
              @if (historyItemId() === item.id) {
                <div class="history-panel">
                  @if (historyLoading()) {
                    <p class="history-state">Загружаем историю…</p>
                  } @else if (historyError()) {
                    <p class="history-state error">{{ historyError() }}</p>
                  } @else {
                    <div class="movement-list">
                      @for (movement of historyMovements(); track movement.id) {
                        <div class="movement" [class.incoming]="number(movement.delta) > 0" [class.outgoing]="number(movement.delta) < 0">
                          <i>{{ number(movement.delta) > 0 ? "+" : "−" }}</i>
                          <div>
                            <strong>{{ number(movement.delta) > 0 ? "Приход" : "Списание" }} · {{ movement.reason }}</strong>
                            <span>{{ formatDateTime(movement.last_event_at) }} · {{ movement.created_by_name }}</span>
                            @if (movement.operation_count > 1) {
                              <small>{{ movement.operation_count }} действия объединены в одну запись</small>
                            }
                          </div>
                          <div class="movement-amount">
                            <b>{{ number(movement.delta) > 0 ? "+" : "−" }}{{ displayNumber(abs(movement.delta)) }} {{ item.unit }}</b>
                            <span>остаток {{ displayNumber(movement.quantity_after) }}</span>
                          </div>
                        </div>
                      }
                      @if (historyItem(); as createdItem) {
                        <div class="movement created">
                          <i>●</i>
                          <div><strong>Позиция добавлена</strong><span>{{ formatDateTime(createdItem.created_at) }}</span></div>
                          <div class="movement-amount"><b>+{{ displayNumber(createdItem.initial_quantity) }} {{ createdItem.unit }}</b><span>начальный остаток</span></div>
                        </div>
                      }
                    </div>
                  }
                </div>
              }
            </article>
          }
              </div>
            </section>
          } @empty {
            @if (!loading()) {
              <div class="empty">
                <b>{{ filtersActive() ? "Ничего не найдено" : "Инвентарь пока пуст" }}</b>
                <span>{{ filtersActive() ? "Попробуйте изменить категорию или поисковый запрос." : "Добавьте магниты или расходники для нужного клуба." }}</span>
              </div>
            }
          }
        </div>
      </section>
    </main>
  `,
  styles: [`
    .toolbar{display:flex;align-items:end;gap:10px;margin:22px 0 0;flex-wrap:wrap}.toolbar label{width:min(260px,100%)}.toolbar .search-filter{flex:1 1 260px}.toolbar .club-filter,.toolbar .category-filter{flex:0 1 220px}.secondary{border:1px solid #d7dce5;background:#fff;box-shadow:none;color:#344054}.clear-filters{border:0;background:transparent;box-shadow:none;color:#667085;padding-inline:8px}.clear-filters:hover{box-shadow:none;color:#344054}.export{background:#101828}
    .new-item{grid-template-columns:repeat(3,minmax(0,1fr))!important}.form-heading{grid-column:1/-1;display:grid;gap:4px}.form-heading b{font-size:18px}.form-heading span{color:var(--muted);font-size:12px}.notes{grid-column:span 2}.save{min-height:42px;align-self:end}
    .summary{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px;margin:20px 0}.summary article{padding:17px 19px;border:1px solid var(--line);border-radius:14px;background:#fff}.summary span{display:block;color:var(--muted);font-size:11px}.summary b{display:block;margin-top:6px;font-size:25px}.summary .warning{border-color:#f4c7a4;background:#fff8f1}.summary .warning b{color:#c04f18}
    .category-groups{display:grid;gap:24px}.category-group{min-width:0}.category-heading{display:flex;align-items:center;justify-content:space-between;margin:0 2px 10px}.category-heading h3{margin:0;font-size:17px}.category-heading span{padding:5px 9px;border-radius:999px;background:#eef0ff;color:#4f46e5;font-size:10px;font-weight:800}.inventory-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.inventory-list>article{padding:20px;border:1px solid var(--line);border-radius:16px;background:#fff;box-shadow:0 8px 24px #19213a08}.inventory-list>article.low{border-color:#f1bc93;box-shadow:0 8px 24px #d3601710}
    .item-main{display:flex;align-items:start;justify-content:space-between;gap:14px}.category{color:var(--primary);font-size:10px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.item-title h3{margin:5px 0 4px;font-size:18px}.item-title p{margin:0;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.added-at{display:block;margin-top:6px;color:#98a2b3;font-size:9px}.status{flex:0 0 auto;padding:6px 8px;border-radius:999px;background:#fff0e5;color:#b54708;font-size:9px;font-weight:800}.status.ok{background:#eaf8f1;color:#087443}
    .stock{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:17px 0;padding:14px;border-radius:12px;background:#f5f7fa}.stock small{display:block;color:var(--muted);font-size:10px}.stock strong{display:block;margin-top:4px;font-size:25px}.stock strong.minimum{color:#667085}.stock em{font-size:11px;font-style:normal;font-weight:700}
    .item-actions{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.item-actions button{min-width:0;padding:10px 6px;font-size:11px}.quick{border:1px solid #d7dce5;background:#fff;box-shadow:none;color:#344054}.quick.minus{color:#b42336}.quick.plus{color:#087443}
    .item-management{display:flex;justify-content:flex-end;gap:12px;margin-top:11px}.item-management button{padding:3px 0;border:0;background:transparent;box-shadow:none;color:#667085;font-size:10px}.item-management button:hover{box-shadow:none;transform:none;color:#344054}.item-management .remove-item{color:#b42336}.item-management .remove-item:hover{color:#8f1425}
    .history-toggle{display:flex;align-items:center;justify-content:space-between;width:100%;margin-top:12px;padding:10px 12px;border:1px solid #e0e4eb;background:#f7f8fa;box-shadow:none;color:#344054;font-size:11px}.history-toggle:hover{transform:none;box-shadow:none}.history-toggle.open{border-color:#c7cdf9;background:#f0f2ff;color:#3f46b5}.history-toggle b{font-size:15px}.history-panel{margin-top:8px;padding:4px 12px;border:1px solid #e0e4eb;border-radius:12px;background:#fbfcfe}.history-state{margin:0;padding:18px 4px;color:var(--muted);text-align:center}.movement-list{display:grid}.movement{display:grid;grid-template-columns:30px minmax(0,1fr) auto;gap:10px;align-items:start;padding:13px 0;border-bottom:1px solid #e8ebf0}.movement:last-child{border-bottom:0}.movement>i{display:grid;place-items:center;width:27px;height:27px;border-radius:50%;background:#eef1f6;color:#667085;font-style:normal;font-weight:900}.movement.incoming>i{background:#dcfae6;color:#087443}.movement.outgoing>i{background:#fff0e5;color:#b54708}.movement strong,.movement span,.movement small{display:block}.movement strong{font-size:11px}.movement span{margin-top:4px;color:#7a8495;font-size:9px}.movement small{margin-top:5px;color:#9a6700;font-size:8px}.movement-amount{text-align:right}.movement-amount b{font-size:12px;white-space:nowrap}.incoming .movement-amount b{color:#087443}.outgoing .movement-amount b{color:#b54708}.movement.created>i{background:#eef0ff;color:#4f46e5;font-size:9px}
    @media(max-width:1100px){.inventory-list{grid-template-columns:1fr}.new-item{grid-template-columns:repeat(2,minmax(0,1fr))!important}.notes{grid-column:1/-1}}
    @media(max-width:760px){section{padding-bottom:105px!important}.toolbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin-top:14px}.toolbar label,.toolbar .club-filter,.toolbar .category-filter,.toolbar .search-filter{width:100%;min-width:0}.toolbar .club-filter{grid-column:1;grid-row:1}.toolbar .category-filter{grid-column:2;grid-row:1}.toolbar .search-filter{grid-column:1/-1;grid-row:2}.toolbar .secondary{grid-column:1;grid-row:3}.toolbar .export{grid-column:2;grid-row:3}.toolbar .clear-filters{grid-column:1/-1;grid-row:3}.toolbar .clear-filters~.secondary,.toolbar .clear-filters~.export{grid-row:4}.toolbar label{gap:4px;font-size:10px}.toolbar input,.toolbar select{min-height:40px!important}.toolbar button{width:100%;min-height:40px}.toolbar .clear-filters{padding-inline:4px}.new-item{grid-template-columns:1fr!important;padding:16px!important}.new-item>*{grid-column:1!important}.summary{grid-template-columns:repeat(3,minmax(0,1fr));gap:7px}.summary article{padding:12px 10px}.summary b{font-size:20px}.inventory-list>article{padding:16px}.item-main{display:grid}.status{justify-self:start}.item-actions{grid-template-columns:1fr 1fr}.item-management{justify-content:space-between}.item-management button{min-height:36px;font-size:11px}.history-toggle{min-height:44px}.history-panel{padding-inline:10px}.movement{grid-template-columns:28px minmax(0,1fr)}.movement-amount{grid-column:2;text-align:left}.movement-amount span{display:inline;margin-left:6px}}
    @media(max-width:390px){.summary{grid-template-columns:1fr}.summary article{display:flex;align-items:center;justify-content:space-between}.summary b{margin:0}}
  `],
})
export class InventoryComponent {
  private http = inject(HttpClient);
  locations = signal<Location[]>([]);
  items = signal<InventoryItem[]>([]);
  locationId = signal("");
  search = signal("");
  categoryFilter = signal("");
  formOpen = signal(false);
  loading = signal(false);
  exportingPdf = signal(false);
  saving = signal(false);
  busyId = signal("");
  historyItemId = signal("");
  historyLoading = signal(false);
  historyError = signal("");
  historyMovements = signal<InventoryMovement[]>([]);
  historyItem = signal<InventoryHistoryItem | null>(null);
  games=signal<Game[]>([]);
  error = signal("");
  categories = ["Магниты", "Батарейки", "Крепёж", "Электроника", "Одноразовые расходники", "Другое"];
  units = ["шт.", "уп.", "м", "л", "кг"];
  draft = { name: "", category: "Магниты", locationId: "", unit: "шт.", quantity: 0, minimumQuantity: 10, notes: "",gameId:"" };

  categoryOptions = computed(() => [...new Set(this.items().map(item => item.category).filter(Boolean))].sort((a, b) => this.compareCategories(a, b)));
  filtersActive = computed(() => Boolean(this.search().trim() || this.categoryFilter()));
  filteredItems = computed(() => {
    const query = this.search().trim().toLocaleLowerCase("ru-RU");
    const category = this.categoryFilter();
    return this.items()
      .filter(item => (!category || item.category === category) && (!query || item.name.toLocaleLowerCase("ru-RU").includes(query)))
      .sort((a, b) => this.compareCategories(a.category, b.category) || a.name.localeCompare(b.name, "ru-RU", { numeric: true }) || a.location_name.localeCompare(b.location_name, "ru-RU"));
  });
  categoryGroups = computed(() => {
    const groups = new Map<string, InventoryItem[]>();
    for (const item of this.filteredItems()) {
      const category = item.category || "Без категории";
      const existing = groups.get(category);
      if (existing) existing.push(item);
      else groups.set(category, [item]);
    }
    return [...groups.entries()].map(([category, items]) => ({ category, items }));
  });
  lowStockCount = computed(() => this.filteredItems().filter((item) => item.low_stock).length);
  magnetQuantity = computed(() => this.displayNumber(this.filteredItems().filter((item) => /магнит/i.test(item.category)).reduce((total, item) => total + this.number(item.quantity), 0)));

  constructor() {
    this.http.get<Location[]>("/api/locations").subscribe({
      next: (locations) => { this.locations.set(locations); if (locations.length === 1) this.draft.locationId = locations[0].id; },
      error: () => this.error.set("Не удалось загрузить список клубов."),
    });
    this.http.get<Game[]>("/api/games").subscribe({next:games=>this.games.set(games)});
    this.load();
  }

  number(value: number | string) { return Number(value) || 0; }
  gamesForLocation(locationId:string){return this.games().filter(game=>game.location_id===locationId).sort((a,b)=>a.name.localeCompare(b.name,"ru"))}
  abs(value: number | string) { return Math.abs(this.number(value)); }
  displayNumber(value: number | string) { return new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(this.number(value)); }
  formatDate(value: string) { return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(value)); }
  formatDateTime(value: string) { return new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
  compareCategories(a: string, b: string) {
    const aIndex = this.categories.indexOf(a);
    const bIndex = this.categories.indexOf(b);
    return (aIndex < 0 ? Number.MAX_SAFE_INTEGER : aIndex) - (bIndex < 0 ? Number.MAX_SAFE_INTEGER : bIndex)
      || a.localeCompare(b, "ru-RU", { numeric: true });
  }

  clearFilters() {
    this.search.set("");
    this.categoryFilter.set("");
  }

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

  exportPdf() {
    if (this.exportingPdf() || !this.filteredItems().length) return;
    this.exportingPdf.set(true);
    this.error.set("");
    const params = new URLSearchParams();
    if (this.locationId()) params.set("locationId", this.locationId());
    if (this.categoryFilter()) params.set("category", this.categoryFilter());
    if (this.search().trim()) params.set("search", this.search().trim());
    const query = params.size ? `?${params.toString()}` : "";
    this.http.get<{ generatedAt: string; items: InventoryPdfItem[] }>(`/api/inventory-export${query}`).subscribe({
      next: async (response) => {
        try {
          const [pdfModule, fontModule] = await Promise.all([
            import("pdfmake/build/pdfmake"),
            import("pdfmake/build/vfs_fonts"),
          ]);
          const pdfMake = ((pdfModule as unknown as { default?: typeof pdfModule }).default || pdfModule);
          const fonts = ((fontModule as unknown as { default?: Record<string, string> }).default || fontModule) as Record<string, string>;
          const scopeParts = [this.locationId()
            ? this.locations().find(location => location.id === this.locationId())?.name || "Выбранный клуб"
            : "Все доступные клубы"];
          if (this.categoryFilter()) scopeParts.push(`Категория: ${this.categoryFilter()}`);
          if (this.search().trim()) scopeParts.push(`Поиск: «${this.search().trim()}»`);
          const definition = buildInventoryPdf({ ...response, scope: scopeParts.join(" · ") });
          pdfMake.createPdf(definition, undefined, undefined, fonts).download(
            `questcontrol-inventory-${response.generatedAt.slice(0, 10)}.pdf`,
            () => this.exportingPdf.set(false),
          );
        } catch {
          this.exportingPdf.set(false);
          this.error.set("Не удалось сформировать PDF.");
        }
      },
      error: () => {
        this.exportingPdf.set(false);
        this.error.set("Не удалось загрузить данные для PDF.");
      },
    });
  }

  create() {
    if (!this.draft.name.trim() || !this.draft.locationId) { this.error.set("Укажите название и клуб."); return; }
    this.saving.set(true);
    this.error.set("");
    this.http.post("/api/inventory", this.draft).subscribe({
      next: () => {
        const locationId = this.draft.locationId;
        this.draft = { name: "", category: "Магниты", locationId, unit: "шт.", quantity: 0, minimumQuantity: 10, notes: "",gameId:"" };
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
      next: () => { this.busyId.set(""); this.load(); if (this.historyItemId() === item.id) this.loadHistory(item); },
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

  changeMinimum(item: InventoryItem) {
    const raw = prompt(`Минимальный остаток для «${item.name}»:`, String(this.number(item.minimum_quantity)));
    if (raw === null) return;
    const minimumQuantity = Number(raw.replace(",", "."));
    if (!Number.isFinite(minimumQuantity) || minimumQuantity < 0) { alert("Введите число не меньше нуля."); return; }
    this.busyId.set(item.id);
    this.error.set("");
    this.http.patch(`/api/inventory/${item.id}`, { minimumQuantity }).subscribe({
      next: () => { this.busyId.set(""); this.load(); },
      error: () => { this.busyId.set(""); this.error.set("Не удалось изменить минимальный остаток."); },
    });
  }
  changeGame(item:InventoryItem,gameId:string){this.busyId.set(item.id);this.http.patch(`/api/inventory/${item.id}`,{gameId:gameId||null}).subscribe({next:()=>{this.busyId.set("");this.load()},error:()=>{this.busyId.set("");this.error.set("Не удалось привязать магнит к игре.")}})}

  removeItem(item: InventoryItem) {
    if (!confirm(`Удалить позицию «${item.name}»? Она исчезнет из инвентаря, но история операций сохранится.`)) return;
    this.busyId.set(item.id);
    this.error.set("");
    this.http.delete(`/api/inventory/${item.id}`).subscribe({
      next: () => {
        this.busyId.set("");
        if (this.historyItemId() === item.id) this.historyItemId.set("");
        this.load();
      },
      error: () => { this.busyId.set(""); this.error.set("Не удалось удалить позицию."); },
    });
  }

  toggleHistory(item: InventoryItem) {
    if (this.historyItemId() === item.id) {
      this.historyItemId.set("");
      return;
    }
    this.historyItemId.set(item.id);
    this.loadHistory(item);
  }

  loadHistory(item: InventoryItem) {
    this.historyLoading.set(true);
    this.historyError.set("");
    this.http.get<{ item: InventoryHistoryItem; movements: InventoryMovement[] }>(`/api/inventory/${item.id}/movements`).subscribe({
      next: (response) => {
        this.historyItem.set(response.item);
        this.historyMovements.set(response.movements);
        this.historyLoading.set(false);
      },
      error: () => {
        this.historyLoading.set(false);
        this.historyError.set("Не удалось загрузить историю операций.");
      },
    });
  }
}
