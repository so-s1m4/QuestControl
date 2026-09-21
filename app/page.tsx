"use client";

import Link from "next/link";
import { useState } from "react";

const rooms = [
  { icon: "VR", name: "VR Arena", meta: "4 игрока · 4/4 ПК онлайн", state: "Игра идёт", time: "34:20", tone: "blue" },
  { icon: "01", name: "Лаборатория", meta: "Этап 4 из 8 · Arduino онлайн", state: "Игра идёт", time: "27:45", tone: "blue" },
  { icon: "02", name: "Бункер", meta: "Готова к следующей игре", state: "Свободна", time: "—", tone: "green" },
];

const primaryNav = ["Обзор", "Бронирования", "Комнаты", "Камеры"];
const navGroups = [
  { title: "Операционная работа", items: ["Смены", "Локации", "Локальные панели", "Сессии"] },
  { title: "Управление", items: ["Инвентарь", "Устройства", "Пользователи"] },
  { title: "Система", items: ["Настройки камер", "AI и датасет", "Интеграции"] },
  { title: "Дополнительно", items: ["Документы", "Журнал действий"] },
];
const extraNav = navGroups.flatMap((group) => group.items);
const nav = [...primaryNav, ...extraNav];

const iconPaths: Record<string, string[]> = {
  "Обзор": ["M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z", "M9 21v-7h6v7"],
  "Бронирования": ["M4 5h16a1 1 0 0 1 1 1v14H3V6a1 1 0 0 1 1-1Z", "M8 3v4M16 3v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"],
  "Комнаты": ["M5 21V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v17M3 21h18", "M14 12h.01"],
  "Камеры": ["M4 8h11a2 2 0 0 1 2 2v8H4a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2Z", "m17 12 5-3v8l-5-3Z"],
  "Смены": ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "M12 7v5l3 2"],
  "Локации": ["M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z", "M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"],
  "Локальные панели": ["M3 4h18v13H3Z", "M8 21h8M12 17v4"],
  "Сессии": ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z", "m10 8 6 4-6 4Z"],
  "Инвентарь": ["m3 8 9-5 9 5-9 5Z", "M3 8v8l9 5 9-5V8M12 13v8"],
  "Устройства": ["M8 3h8v18H8Z", "M11 17h2M5 8H3m18 0h-2M5 12H3m18 0h-2"],
  "Пользователи": ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 14 0", "M17 11a3 3 0 0 0 0-6M18 15a5 5 0 0 1 4 5"],
  "Настройки камер": ["M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M19 13.5v-3l-2-.7-.7-1.7.9-1.9-2.1-2.1-1.9.9-1.7-.7L13.5 2h-3l-.7 2-1.7.7-1.9-.9-2.1 2.1.9 1.9-.7 1.7-2 .7v3l2 .7.7 1.7-.9 1.9 2.1 2.1 1.9-.9 1.7.7.7 2h3l.7-2 1.7-.7 1.9.9 2.1-2.1-.9-1.9.7-1.7Z"],
  "AI и датасет": ["m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5Z", "m19 15 .7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7Z"],
  "Интеграции": ["m9 15 6-6", "M7.5 17.5 5 20a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0M16 12a3.5 3.5 0 0 1 5 0l-3 3a3.5 3.5 0 0 1-5 0"],
  "Документы": ["M6 2h8l4 4v16H6Z", "M14 2v5h5M9 13h6M9 17h6"],
  "Журнал действий": ["M8 6h12M8 12h12M8 18h12", "M3.5 6h.01M3.5 12h.01M3.5 18h.01"],
  "Ещё": ["M5 12h.01M12 12h.01M19 12h.01"],
  "Check-in гостей": ["M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM2 21a7 7 0 0 1 12-5", "m16 19 2 2 4-5"],
};

function NavIcon({ item }: { item: string }) {
  return <svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true">{(iconPaths[item] || iconPaths["Ещё"]).map((path) => <path d={path} key={path} />)}</svg>;
}

export default function Home() {
  const [active, setActive] = useState("Обзор");
  const [notice, setNotice] = useState("");
  const [moreOpen, setMoreOpen] = useState(false);
  const selectNav = (item: string) => {
    setActive(item);
    setMoreOpen(false);
  };
  const act = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 2600);
  };

  return (
    <main className="shell">
      <aside>
        <div className="brand"><span>Q</span><div>QUEST<span>CONTROL</span></div></div>
        <nav>
          <span className="nav-group">Основное</span>
          {primaryNav.map((item) => <button key={item} className={`nav-primary ${active === item ? "active" : ""}`} onClick={() => selectNav(item)}><NavIcon item={item} />{item}</button>)}
          {navGroups.map((group) => <div className="nav-section" key={group.title}>
            <span className="nav-group">{group.title}</span>
            {group.items.map((item) => <button key={item} className={`nav-extra ${active === item ? "active" : ""}`} onClick={() => selectNav(item)}><NavIcon item={item} />{item}</button>)}
          </div>)}
          <button className={`more-nav ${extraNav.includes(active) || moreOpen ? "active" : ""}`} aria-expanded={moreOpen} onClick={() => setMoreOpen(true)}><NavIcon item="Ещё" />Ещё</button>
          <Link className="checkin-nav" href="/reception/checkin"><NavIcon item="Check-in гостей" />Check-in гостей <span>↗</span></Link>
        </nav>
        <div className="system"><p>Состояние системы</p><div><b /><span>Все сервисы работают<small>Обновлено сейчас</small></span></div></div>
        <div className="profile"><span>AM</span><div>Алексей Морозов<small>Владелец</small></div><b>•••</b></div>
      </aside>

      {moreOpen && <div className="mobile-more-backdrop" role="presentation" onClick={() => setMoreOpen(false)}>
        <section className="mobile-more-sheet" role="dialog" aria-modal="true" aria-label="Дополнительная навигация" onClick={(event) => event.stopPropagation()}>
          <div className="sheet-handle" />
          <div className="sheet-header"><div><small>QUESTCONTROL</small><h2>Все разделы</h2></div><button aria-label="Закрыть меню" onClick={() => setMoreOpen(false)}>×</button></div>
          {navGroups.map((group) => <div className="sheet-group" key={group.title}>
            <p>{group.title}</p>
            <div className="sheet-links">
              {group.items.map((item) => <button key={item} className={active === item ? "active" : ""} onClick={() => selectNav(item)}><NavIcon item={item} />{item}</button>)}
            </div>
          </div>)}
          <div className="sheet-links reception-link">
            <Link href="/reception/checkin"><NavIcon item="Check-in гостей" />Check-in гостей <span>↗</span></Link>
          </div>
        </section>
      </div>}

      <section className="content">
        <header><div><h1>{active}</h1><p>Понедельник, 28 июля · Локация «Центр»</p></div><div className="header-actions"><button className="icon">⌕</button><button className="icon">◴</button><button className="primary" onClick={() => act("Форма бронирования открыта")}>＋ Новое бронирование</button></div></header>

        {active === "Обзор" ? <>
          <Link className="reception-callout" href="/reception/checkin">
            <span className="reception-mark">R</span>
            <div>
              <small>Ресепшен · Escapers St. Pölten</small>
              <h2>Онлайн check-in гостей</h2>
              <p>Выбор бронирования, анкеты всех участников и отправка данных в Time to Grow.</p>
            </div>
            <strong>Открыть check-in <b>↗</b></strong>
          </Link>

          <div className="metrics">
            <article><div><span>Бронирований сегодня</span><strong>12</strong><small className="up">↑ 20% к прошлому понедельнику</small></div><em>▣</em></article>
            <article><div><span>Выручка сегодня</span><strong>€ 1 840</strong><small>8 из 12 оплачено</small></div><em>€</em></article>
            <article><div><span>Активные игры</span><strong>2</strong><small><b className="dot" /> Всё работает штатно</small></div><em>▶</em></article>
            <article><div><span>Устройства онлайн</span><strong>23 <i>/ 24</i></strong><small className="warn">● Камера 2 недоступна</small></div><em>⌁</em></article>
          </div>

          <div className="section-title"><div><h2>Комнаты</h2><p>Управление активными игровыми сессиями</p></div><button onClick={() => setActive("Комнаты")}>Все комнаты →</button></div>
          <div className="rooms">
            {rooms.map((room) => <article key={room.name}>
              <div className="room-top"><span className={`room-icon ${room.tone}`}>{room.icon}</span><div><h3>{room.name}</h3><p>{room.meta}</p></div><b className={room.tone}>{room.state}</b></div>
              <div className="timer"><span>Осталось времени</span><strong>{room.time}</strong></div>
              <div className="room-actions">{room.time !== "—" ? <><button onClick={() => act(`${room.name}: пауза`)}>Ⅱ Пауза</button><button onClick={() => act(`${room.name}: добавлено 5 минут`)}>＋ 5 мин</button><button className="danger" onClick={() => act(`${room.name}: завершение требует подтверждения`)}>Завершить</button></> : <button className="wide" onClick={() => act(`${room.name}: сессия запущена`)}>▶ Начать игру</button>}</div>
            </article>)}
          </div>

          <div className="lower">
            <section className="schedule"><div className="section-title"><div><h2>Ближайшие бронирования</h2><p>Следующие игры на сегодня</p></div><button onClick={() => setActive("Бронирования")}>Календарь →</button></div>
              {[["15:30","VR Arena","Мария Шульц · 4 игрока","Оплачено"],["16:00","Бункер","Thomas Klein · 5 игроков","Не оплачено"],["17:15","Лаборатория","Анна Петрова · 3 игрока","Оплачено"]].map((b) => <div className="booking" key={b[0]}><strong>{b[0]}</strong><i /><div><b>{b[1]}</b><span>{b[2]}</span></div><em className={b[3] === "Оплачено" ? "paid" : "unpaid"}>{b[3]}</em><button>•••</button></div>)}
            </section>
            <section className="health"><div className="section-title"><div><h2>Инфраструктура</h2><p>Состояние подключений</p></div></div>
              {[["Raspberry Pi · Лаборатория","Онлайн","18 мс"],["Room Agent · Бункер","Онлайн","24 мс"],["Tuya Cloud","Онлайн","142 мс"],["Камера 2 · Коридор","Офлайн","4 мин"]].map((h) => <div className="health-row" key={h[0]}><b className={h[1] === "Онлайн" ? "" : "bad"} /><span>{h[0]}<small>{h[2]}</small></span><em>{h[1]}</em></div>)}
            </section>
          </div>
        </> : <div className="module"><span>{nav.indexOf(active) + 1}</span><h2>{active}</h2><p>Модуль подключён к общему API и защищён ролевыми правами. В рабочем репозитории доступны полноценные маршруты, модели данных и интеграции.</p><button className="primary" onClick={() => act(`${active}: действие сохранено в журнале`)}>Выполнить тестовое действие</button></div>}
      </section>
      {notice && <div className="toast">✓ {notice}</div>}
    </main>
  );
}
