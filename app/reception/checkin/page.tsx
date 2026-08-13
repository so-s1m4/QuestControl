"use client";

import Link from "next/link";
import { useState } from "react";
import "./checkin.css";

type Language = "en" | "de";
type Step = "reservation" | "guests" | "done";

const copy = {
  en: {
    welcome: "Welcome to",
    index: "Index",
    title: "Check-in",
    select: "Please select your reservation:",
    guests: "How many guests have arrived?",
    booked: "booked",
    confirm: "Confirm check-in",
    success: "You’re all checked in!",
    successNote: "Our game master will meet you here shortly.",
    another: "Check in another group",
    language: "English",
  },
  de: {
    welcome: "Willkommen bei",
    index: "Startseite",
    title: "Check-in",
    select: "Bitte wählen Sie Ihre Reservierung:",
    guests: "Wie viele Gäste sind angekommen?",
    booked: "gebucht",
    confirm: "Check-in bestätigen",
    success: "Der Check-in ist erledigt!",
    successNote: "Unser Game Master ist gleich für Sie da.",
    another: "Weitere Gruppe einchecken",
    language: "Deutsch",
  },
};

const reservations = [
  { id: 1, time: "14:30", room: "Krampus", name: "Anna Berger", guests: 5 },
  { id: 2, time: "16:00", room: "The Nun", name: "Lukas Gruber", guests: 4 },
  { id: 3, time: "17:30", room: "Zombie Apocalypse", name: "Sophie Wagner", guests: 6 },
];

export default function CheckinPage() {
  const [language, setLanguage] = useState<Language>("en");
  const [step, setStep] = useState<Step>("reservation");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [guestCount, setGuestCount] = useState(1);
  const t = copy[language];
  const selected = reservations.find((reservation) => reservation.id === selectedId);

  const selectReservation = (id: number, guests: number) => {
    setSelectedId(id);
    setGuestCount(guests);
    setStep("guests");
  };

  const reset = () => {
    setSelectedId(null);
    setGuestCount(1);
    setStep("reservation");
  };

  return (
    <main className="checkin-page">
      <div className="checkin-glow glow-one" />
      <div className="checkin-glow glow-two" />

      <header className="checkin-welcome">
        <span>{t.welcome}</span> <strong>Escapers_Peolten</strong>
      </header>

      <section className="checkin-content" aria-live="polite">
        {step === "reservation" && <Link className="checkin-back" href="/">‹&nbsp; {t.index}</Link>}
        {step === "guests" && <button className="checkin-back" onClick={() => setStep("reservation")}>‹&nbsp; {t.title}</button>}

        <h1>{t.title}</h1>

        {step === "reservation" && (
          <div className="checkin-card reservation-card">
            <h2>{t.select}</h2>
            <div className="reservation-list">
              {reservations.map((reservation) => (
                <button key={reservation.id} onClick={() => selectReservation(reservation.id, reservation.guests)}>
                  <span className="reservation-time">{reservation.time}</span>
                  <span className="reservation-info">
                    <strong>{reservation.room}</strong>
                    <small>{reservation.name} · {reservation.guests} {t.booked}</small>
                  </span>
                  <span className="reservation-arrow">›</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {step === "guests" && selected && (
          <div className="checkin-card guests-card">
            <div className="selected-reservation">
              <span>{selected.time}</span>
              <div><strong>{selected.room}</strong><small>{selected.name}</small></div>
            </div>
            <h2>{t.guests}</h2>
            <div className="counter" aria-label={t.guests}>
              <button aria-label="Remove one guest" onClick={() => setGuestCount((count) => Math.max(1, count - 1))}>−</button>
              <strong>{guestCount}</strong>
              <button aria-label="Add one guest" onClick={() => setGuestCount((count) => Math.min(selected.guests, count + 1))}>＋</button>
            </div>
            <button className="confirm-button" onClick={() => setStep("done")}>{t.confirm}</button>
          </div>
        )}

        {step === "done" && (
          <div className="checkin-card success-card">
            <div className="success-mark">✓</div>
            <h2>{t.success}</h2>
            <p>{t.successNote}</p>
            <button className="confirm-button" onClick={reset}>{t.another}</button>
          </div>
        )}
      </section>

      <button className="language-switcher" onClick={() => setLanguage((current) => current === "en" ? "de" : "en")}>
        <span>◎</span> {t.language}
      </button>
    </main>
  );
}
