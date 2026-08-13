import { Component, OnInit, computed, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import QRCode from "qrcode";

type Language="de"|"en";
type CheckinLocation="st-poelten"|"vienna";
type Step="reservation"|"guests"|"details"|"done";
type Reservation={visitId:string;bookingId:string;time:string;room:string;name:string;guests:number};
type Participant={firstName:string;lastName:string;email:string;phone:string;birthDate:string;gender:""|"female"|"male"|"non-binary";allowMarketingMaterials:boolean;waiver:boolean;privacy:boolean;submitted:boolean};

const emptyParticipant=():Participant=>({firstName:"",lastName:"",email:"",phone:"+43 ",birthDate:"",gender:"",allowMarketingMaterials:false,waiver:false,privacy:false,submitted:false});
const copy={
  de:{index:"QuestControl",title:"Check-in",select:"Bitte wählen Sie Ihre Reservierung:",guests:"Wie viele Gäste sind angekommen?",booked:"gebucht",confirm:"Check-in bestätigen",details:"Bitte fülle deine Daten aus",participant:"Teilnehmer",progress:"übermittelt",firstName:"Vorname",lastName:"Nachname",email:"E-Mail",phone:"Telefonnummer",birthDate:"Geburtsdatum",birthdayHint:"Geburtsdatum eintragen und eine Geburtstagsüberraschung erhalten 🎁",gender:"Geschlecht",female:"Weiblich",male:"Männlich",diverse:"Nicht-binär",marketing:"Ich möchte Marketing-Neuigkeiten erhalten",waiver:"Ich stimme dem",waiverLabel:"Haftungsausschluss",privacy:"Ich stimme der",privacyLabel:"Datenschutzerklärung",medical:"Bitte sprich vor der Nutzung eines VR-Headsets mit deinem Arzt, wenn du schwanger bist, an einer Herzerkrankung, Epilepsie oder einer anderen relevanten Erkrankung leidest.",next:"Senden & nächste Person",finish:"Check-in abschließen",online:"Online Check-in",scan:"Scannen und die Daten dieser Person am Handy ausfüllen.",group:"Eure Gruppe",success:"Der Check-in ist erledigt!",successNote:"Die Daten wurden an Time to Grow übermittelt. Unser Game Master ist gleich für Sie da.",another:"Weitere Gruppe einchecken",language:"English",eyebrow:"Self Check-in · Traisenpark",loading:"Reservierungen werden geladen…",empty:"Aktuell sind keine Reservierungen für den Check-in verfügbar.",retry:"Erneut versuchen",loadError:"Reservierungen konnten nicht geladen werden.",sending:"Wird gesendet…",submitError:"Das Formular konnte nicht gesendet werden. Bitte erneut versuchen oder unser Team fragen."},
  en:{index:"QuestControl",title:"Check-in",select:"Please select your reservation:",guests:"How many guests have arrived?",booked:"booked",confirm:"Confirm check-in",details:"Please fill out your details",participant:"Participant",progress:"submitted",firstName:"First name",lastName:"Last name",email:"Email",phone:"Phone number",birthDate:"Date of birth",birthdayHint:"Enter your birthday and receive a birthday gift from us 🎁",gender:"Gender",female:"Female",male:"Male",diverse:"Non-binary",marketing:"I would like to receive marketing updates",waiver:"I agree to the",waiverLabel:"Waiver",privacy:"I agree to the",privacyLabel:"Privacy policy",medical:"Please consult your doctor before using a VR headset if you are pregnant, have a heart condition, epilepsy, or another relevant medical condition.",next:"Submit & next participant",finish:"Complete check-in",online:"Online check-in",scan:"Scan to fill this participant’s form on a phone.",group:"Your group",success:"You’re all checked in!",successNote:"The details were sent to Time to Grow. Our game master will meet you here shortly.",another:"Check in another group",language:"Deutsch",eyebrow:"Self check-in · Traisenpark",loading:"Loading reservations…",empty:"There are no upcoming reservations available for check-in.",retry:"Try again",loadError:"Reservations could not be loaded.",sending:"Sending…",submitError:"The form could not be submitted. Please try again or ask our team for help."},
};

@Component({
  selector:"app-reception-checkin",
  standalone:true,
  imports:[FormsModule,RouterLink],
  templateUrl:"./reception-checkin.component.html",
  styleUrl:"./reception-checkin.component.css",
})
export class ReceptionCheckinComponent implements OnInit{
  private http=inject(HttpClient);
  language=signal<Language>("de");
  t=computed(()=>copy[this.language()]);
  clubLocation=signal<CheckinLocation>("st-poelten");
  locationName=computed(()=>this.clubLocation()==="vienna"?"Wien":"St. Pölten");
  step=signal<Step>("reservation");
  reservations=signal<Reservation[]>([]);
  loading=signal(true);
  loadError=signal(false);
  selected=signal<Reservation|null>(null);
  guestCount=signal(1);
  participants=signal<Participant[]>([]);
  participantIndex=signal(0);
  draft=signal<Participant>(emptyParticipant());
  submitting=signal(false);
  submitError=signal(false);
  qrDataUrl=signal("");
  maxBirthDate=new Date().toISOString().slice(0,10);

  ngOnInit(){const requested=new URLSearchParams(location.search).get("location");if(requested==="vienna")this.clubLocation.set("vienna");this.loadReservations()}
  toggleLanguage(){this.language.update(value=>value==="de"?"en":"de")}
  changeLocation(next:CheckinLocation){
    if(next===this.clubLocation())return;
    this.clubLocation.set(next);this.selected.set(null);this.guestCount.set(1);this.participants.set([]);this.participantIndex.set(0);this.draft.set(emptyParticipant());this.step.set("reservation");this.qrDataUrl.set("");
    const url=new URL(location.href);url.search="";url.searchParams.set("location",next);history.replaceState({},"",url);this.loadReservations();
  }
  loadReservations(){
    this.loading.set(true);this.loadError.set(false);
    this.http.get<{data:Reservation[]}>(`/api/reception/checkin/visits?location=${this.clubLocation()}`).subscribe({
      next:payload=>{this.reservations.set(Array.isArray(payload.data)?payload.data:[]);this.loading.set(false);this.openFromUrl()},
      error:()=>{this.reservations.set([]);this.loading.set(false);this.loadError.set(true)},
    });
  }
  selectReservation(reservation:Reservation){this.selected.set(reservation);this.guestCount.set(reservation.guests);this.step.set("guests")}
  decreaseGuests(){this.guestCount.update(value=>Math.max(1,value-1))}
  increaseGuests(){const max=this.selected()?.guests||1;this.guestCount.update(value=>Math.min(max,value+1))}
  startDetails(){this.participants.set(Array.from({length:this.guestCount()},emptyParticipant));this.participantIndex.set(0);this.draft.set(emptyParticipant());this.submitError.set(false);this.step.set("details");void this.refreshQr()}
  updateDraft(patch:Partial<Participant>){this.draft.update(value=>({...value,...patch}));this.submitError.set(false)}
  async submitParticipant(){
    const reservation=this.selected();const draft=this.draft();
    if(!reservation||this.submitting()||draft.submitted)return;
    this.submitting.set(true);this.submitError.set(false);
    this.http.post("/api/reception/checkin/participants",{location:this.clubLocation(),visitId:reservation.visitId,bookingId:reservation.bookingId,firstName:draft.firstName,lastName:draft.lastName,email:draft.email,phone:draft.phone,birthday:draft.birthDate,gender:draft.gender,allowMarketingMaterials:draft.allowMarketingMaterials,acceptWaiver:draft.waiver,acceptPrivacyPolicy:draft.privacy}).subscribe({
      next:()=>{
        const updated=[...this.participants()];updated[this.participantIndex()]={...draft,submitted:true};this.participants.set(updated);
        const next=updated.findIndex((participant,index)=>index>this.participantIndex()&&!participant.submitted);
        if(next===-1){this.step.set("done");this.qrDataUrl.set("")}else{this.participantIndex.set(next);this.draft.set(updated[next]);void this.refreshQr()}
        this.submitting.set(false);
      },
      error:()=>{this.submitting.set(false);this.submitError.set(true)},
    });
  }
  reset(){const url=new URL(location.href);url.search="";url.searchParams.set("location",this.clubLocation());history.replaceState({},"",url);this.selected.set(null);this.guestCount.set(1);this.participants.set([]);this.participantIndex.set(0);this.draft.set(emptyParticipant());this.step.set("reservation");this.loadReservations()}
  submittedCount(){return this.participants().filter(item=>item.submitted).length}
  submitLabel(){return this.submitting()?this.t().sending:(this.participantIndex()<this.guestCount()-1?this.t().next:this.t().finish)}
  private openFromUrl(){
    const params=new URLSearchParams(location.search);const visit=params.get("visit");const total=Number(params.get("participants"));const slot=Number(params.get("participant"));
    const reservation=this.reservations().find(item=>item.visitId===visit);
    if(!reservation||!Number.isInteger(total)||total<1||total>reservation.guests)return;
    this.selected.set(reservation);this.guestCount.set(total);this.participants.set(Array.from({length:total},emptyParticipant));this.participantIndex.set(Number.isInteger(slot)?Math.min(Math.max(slot,1),total)-1:0);this.draft.set(emptyParticipant());this.step.set("details");void this.refreshQr();
  }
  private async refreshQr(){
    const reservation=this.selected();if(!reservation)return;
    const url=new URL(location.href);url.search="";url.searchParams.set("location",this.clubLocation());url.searchParams.set("visit",reservation.visitId);url.searchParams.set("participants",String(this.guestCount()));url.searchParams.set("participant",String(this.participantIndex()+1));
    this.qrDataUrl.set(await QRCode.toDataURL(url.toString(),{width:420,margin:1,errorCorrectionLevel:"M",color:{dark:"#191919",light:"#ffffff"}}));
  }
}
