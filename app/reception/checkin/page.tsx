"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { QRCodeSVG } from "qrcode.react";
import "./checkin.css";

type Language = "en" | "de";
type Step = "reservation" | "guests" | "details" | "done";
type Participant = {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  birthDate: string;
  gender: string;
  marketingOptOut: boolean;
  waiver: boolean;
  privacy: boolean;
};

const emptyParticipant = (): Participant => ({
  firstName: "",
  lastName: "",
  email: "",
  phone: "+43 ",
  birthDate: "",
  gender: "",
  marketingOptOut: false,
  waiver: false,
  privacy: false,
});

const copy = {
  en: {
    welcome: "Welcome to",
    index: "Index",
    title: "Check-in",
    select: "Please select your reservation:",
    guests: "How many guests have arrived?",
    booked: "booked",
    confirm: "Confirm check-in",
    details: "Please fill out your details",
    participant: "Participant",
    progress: "completed",
    firstName: "First name",
    lastName: "Last name",
    email: "Email",
    phone: "Phone number",
    birthDate: "Date of birth",
    birthdayHint: "Enter your birthday and receive a birthday gift from us 🎁",
    gender: "Gender",
    female: "Female",
    male: "Male",
    diverse: "Diverse",
    noAnswer: "Prefer not to say",
    marketing: "Opt out from marketing materials",
    waiver: "I agree to the",
    waiverLabel: "Waiver",
    privacy: "I agree to the",
    privacyLabel: "Privacy policy",
    medical: "Please consult your doctor before using a VR headset if you are pregnant, have a heart condition, epilepsy, or another relevant medical condition.",
    nextParticipant: "Save & next participant",
    finish: "Complete check-in",
    online: "Online check-in",
    scan: "Scan to fill this participant’s form on a phone.",
    group: "Your group",
    success: "You’re all checked in!",
    successNote: "Our game master will meet you here shortly.",
    another: "Check in another group",
    language: "Deutsch",
    eyebrow: "Self check-in · Traisenpark",
  },
  de: {
    welcome: "Willkommen bei",
    index: "Startseite",
    title: "Check-in",
    select: "Bitte wählen Sie Ihre Reservierung:",
    guests: "Wie viele Gäste sind angekommen?",
    booked: "gebucht",
    confirm: "Check-in bestätigen",
    details: "Bitte fülle deine Daten aus",
    participant: "Teilnehmer",
    progress: "ausgefüllt",
    firstName: "Vorname",
    lastName: "Nachname",
    email: "E-Mail",
    phone: "Telefonnummer",
    birthDate: "Geburtsdatum",
    birthdayHint: "Geburtsdatum eintragen und eine Geburtstagsüberraschung erhalten 🎁",
    gender: "Geschlecht",
    female: "Weiblich",
    male: "Männlich",
    diverse: "Divers",
    noAnswer: "Keine Angabe",
    marketing: "Keine Marketing-Nachrichten erhalten",
    waiver: "Ich stimme dem",
    waiverLabel: "Haftungsausschluss",
    privacy: "Ich stimme der",
    privacyLabel: "Datenschutzerklärung",
    medical: "Bitte sprich vor der Nutzung eines VR-Headsets mit deinem Arzt, wenn du schwanger bist, an einer Herzerkrankung, Epilepsie oder einer anderen relevanten Erkrankung leidest.",
    nextParticipant: "Speichern & nächste Person",
    finish: "Check-in abschließen",
    online: "Online Check-in",
    scan: "Scannen und die Daten dieser Person am Handy ausfüllen.",
    group: "Eure Gruppe",
    success: "Der Check-in ist erledigt!",
    successNote: "Unser Game Master ist gleich für Sie da.",
    another: "Weitere Gruppe einchecken",
    language: "English",
    eyebrow: "Self Check-in · Traisenpark",
  },
};

const reservations = [
  { id: 1, time: "14:30", room: "Krampus", name: "Anna Berger", guests: 5 },
  { id: 2, time: "16:00", room: "The Nun", name: "Lukas Gruber", guests: 4 },
  { id: 3, time: "17:30", room: "Zombie Apocalypse", name: "Sophie Wagner", guests: 6 },
];

export default function CheckinPage() {
  const [language, setLanguage] = useState<Language>("de");
  const [step, setStep] = useState<Step>("reservation");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [guestCount, setGuestCount] = useState(1);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [participantIndex, setParticipantIndex] = useState(0);
  const [draft, setDraft] = useState<Participant>(emptyParticipant);
  const [mobileUrl, setMobileUrl] = useState("");
  const t = copy[language];
  const selected = reservations.find((reservation) => reservation.id === selectedId);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reservationId = Number(params.get("reservation"));
    const total = Number(params.get("participants"));
    const slot = Number(params.get("participant"));
    const reservation = reservations.find((item) => item.id === reservationId);
    if (!reservation || !Number.isInteger(total) || total < 1 || total > reservation.guests) return;
    const safeSlot = Number.isInteger(slot) ? Math.min(Math.max(slot, 1), total) : 1;
    const timer = window.setTimeout(() => {
      setSelectedId(reservation.id);
      setGuestCount(total);
      setParticipants(Array.from({ length: total }, emptyParticipant));
      setParticipantIndex(safeSlot - 1);
      setDraft(emptyParticipant());
      setStep("details");
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (step !== "details" || !selected) return;
    const url = new URL(window.location.href);
    url.searchParams.set("reservation", String(selected.id));
    url.searchParams.set("participants", String(guestCount));
    url.searchParams.set("participant", String(participantIndex + 1));
    const timer = window.setTimeout(() => setMobileUrl(url.toString()), 0);
    return () => window.clearTimeout(timer);
  }, [step, selected, guestCount, participantIndex]);

  const selectReservation = (id: number, guests: number) => {
    setSelectedId(id);
    setGuestCount(guests);
    setStep("guests");
  };

  const reset = () => {
    setSelectedId(null);
    setGuestCount(1);
    setParticipants([]);
    setParticipantIndex(0);
    setDraft(emptyParticipant());
    setStep("reservation");
  };

  const startDetails = () => {
    setParticipants(Array.from({ length: guestCount }, emptyParticipant));
    setParticipantIndex(0);
    setDraft(emptyParticipant());
    setStep("details");
  };

  const updateField = <K extends keyof Participant,>(field: K, value: Participant[K]) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const openParticipant = (index: number) => {
    setParticipantIndex(index);
    setDraft(participants[index] ?? emptyParticipant());
  };

  const saveParticipant = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const updated = [...participants];
    updated[participantIndex] = draft;
    setParticipants(updated);
    if (participantIndex < guestCount - 1) {
      const next = participantIndex + 1;
      setParticipantIndex(next);
      setDraft(updated[next] ?? emptyParticipant());
    } else {
      setStep("done");
    }
  };

  return (
    <main className="checkin-page">
      <div className="checkin-glow glow-one" />
      <div className="checkin-glow glow-two" />

      <header className="checkin-welcome">
        <div className="escapers-wordmark" aria-label="Escapers">ESCΛPERS</div>
        <div className="checkin-location"><span />St. Pölten</div>
      </header>

      <section className={`checkin-content ${step === "details" ? "details-mode" : ""}`} aria-live="polite">
        {step === "reservation" && <Link className="checkin-back" href="/">‹&nbsp; {t.index}</Link>}
        {step === "guests" && <button className="checkin-back" onClick={() => setStep("reservation")}>‹&nbsp; {t.title}</button>}
        {step === "details" && <button className="checkin-back" onClick={() => setStep("guests")}>‹&nbsp; {t.participant}</button>}

        <p className="checkin-eyebrow">{t.eyebrow}</p>
        <h1>{t.title}</h1>

        {step === "reservation" && (
          <div className="checkin-card reservation-card">
            <div className="card-number">01</div>
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
            <div className="card-number">02</div>
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
            <button className="confirm-button" onClick={startDetails}>{t.confirm}</button>
          </div>
        )}

        {step === "details" && selected && (
          <div className="details-layout">
            <form className="checkin-card participant-form" onSubmit={saveParticipant}>
              <div className="card-number">03</div>
              <div className="form-heading">
                <div>
                  <span>{t.participant} {participantIndex + 1} / {guestCount}</span>
                  <h2>{t.details}</h2>
                </div>
                <strong>{selected.time} · {selected.room}</strong>
              </div>

              <div className="form-grid">
                <label><span>{t.firstName} *</span><input required autoFocus value={draft.firstName} onChange={(e) => updateField("firstName", e.target.value)} autoComplete="given-name" /></label>
                <label><span>{t.lastName} *</span><input required value={draft.lastName} onChange={(e) => updateField("lastName", e.target.value)} autoComplete="family-name" /></label>
                <label><span>{t.email} *</span><input required type="email" value={draft.email} onChange={(e) => updateField("email", e.target.value)} autoComplete="email" /></label>
                <label><span>{t.phone}</span><input type="tel" value={draft.phone} onChange={(e) => updateField("phone", e.target.value)} autoComplete="tel" /></label>
                <label className="birth-field"><span>{t.birthDate} *</span><input required type="date" value={draft.birthDate} onChange={(e) => updateField("birthDate", e.target.value)} /><small>{t.birthdayHint}</small></label>
                <label><span>{t.gender}</span><select value={draft.gender} onChange={(e) => updateField("gender", e.target.value)}><option value="">—</option><option value="female">{t.female}</option><option value="male">{t.male}</option><option value="diverse">{t.diverse}</option><option value="none">{t.noAnswer}</option></select></label>
              </div>

              <label className="consent-row optional"><input type="checkbox" checked={draft.marketingOptOut} onChange={(e) => updateField("marketingOptOut", e.target.checked)} /><span className="toggle" /> <span>{t.marketing}</span></label>
              <label className="consent-row"><input required type="checkbox" checked={draft.waiver} onChange={(e) => updateField("waiver", e.target.checked)} /><span className="toggle" /> <span>{t.waiver} <b>{t.waiverLabel}</b> *</span></label>
              <label className="consent-row"><input required type="checkbox" checked={draft.privacy} onChange={(e) => updateField("privacy", e.target.checked)} /><span className="toggle" /> <span>{t.privacy} <b>{t.privacyLabel}</b> *</span></label>

              <div className="medical-note"><strong>△</strong><span>{t.medical}</span></div>
              <button className="confirm-button" type="submit">{participantIndex < guestCount - 1 ? t.nextParticipant : t.finish}</button>
            </form>

            <aside className="details-side">
              <div className="online-card">
                <span>{t.online}</span>
                {mobileUrl && <div className="qr-wrap"><QRCodeSVG value={mobileUrl} size={190} bgColor="#ffffff" fgColor="#191919" level="M" /></div>}
                <p>{t.scan}</p>
              </div>
              <div className="group-card">
                <h3>{t.group}</h3>
                {participants.map((participant, index) => {
                  const complete = Boolean(participant.firstName && participant.lastName && participant.waiver && participant.privacy);
                  const firstIncomplete = participants.findIndex((item) => !(item.firstName && item.lastName && item.waiver && item.privacy));
                  const disabled = !complete && index !== firstIncomplete;
                  return <button type="button" disabled={disabled} key={index} className={index === participantIndex ? "active" : ""} onClick={() => openParticipant(index)}><span>{complete ? "✓" : index + 1}</span><div><strong>{participant.firstName || `${t.participant} ${index + 1}`}</strong><small>{complete ? t.progress : `${index + 1} / ${guestCount}`}</small></div></button>;
                })}
              </div>
            </aside>
          </div>
        )}

        {step === "done" && (
          <div className="checkin-card success-card">
            <div className="card-number">04</div>
            <div className="success-mark">✓</div>
            <h2>{t.success}</h2>
            <p>{participants.length} {t.participant.toLowerCase()} · {t.successNote}</p>
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
