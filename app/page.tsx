"use client";

import { useState } from "react";

const rooms = [
  { icon: "VR", name: "VR Arena", meta: "4 игрока · 4/4 ПК онлайн", state: "Игра идёт", time: "34:20", tone: "blue" },
  { icon: "01", name: "Лаборатория", meta: "Этап 4 из 8 · Arduino онлайн", state: "Игра идёт", time: "27:45", tone: "blue" },
  { icon: "02", name: "Бункер", meta: "Готова к следующей игре", state: "Свободна", time: "—", tone: "green" },
];

const nav = ["Обзор", "Бронирования", "Комнаты", "Локальные панели", "Камеры", "Устройства", "Журнал действий"];

export default function Home() {
  const [active, setActive] = useState("Обзор");
  const [notice, setNotice] = useState("");
  const act = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(""), 2600);
  };

  return (
    <main className="shell">
      <aside>
        <div className="brand"><span>Q</span><div>QUEST<span>CONTROL</span></div></div>
        <nav>{nav.map((item) => <button key={item} className={active === item ? "active" : ""} onClick={() => setActive(item)}><i />{item}</button>)}</nav>
        <div className="system"><p>Состояние системы</p><div><b /><span>Все сервисы работают<small>Обновлено сейчас</small></span></div></div>
        <div className="profile"><span>AM</span><div>Алексей Морозов<small>Владелец</small></div><b>•••</b></div>
      </aside>

      <section className="content">
        <header><div><h1>{active}</h1><p>Понедельник, 28 июля · Локация «Центр»</p></div><div className="header-actions"><button className="icon">⌕</button><button className="icon">◴</button><button className="primary" onClick={() => act("Форма бронирования открыта")}>＋ Новое бронирование</button></div></header>

        {active === "Обзор" ? <>
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
