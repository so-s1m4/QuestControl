import { Component, OnInit, computed, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute } from "@angular/router";
import QRCode from "qrcode";

type Language="de"|"en";
type CheckinLocation="st-poelten"|"vienna";
type Step="reservation"|"guests"|"details"|"done";
type Reservation={visitId:string;bookingId:string;time:string;room:string;name:string;guests:number;maxGuests:number};
type CheckinDocuments={waiver:Partial<Record<Language,string>>;privacy:Partial<Record<Language,string>>};
type Participant={firstName:string;lastName:string;email:string;phone:string;birthDate:string;gender:""|"female"|"male"|"non-binary";allowMarketingMaterials:boolean;waiver:boolean;privacy:boolean;submitted:boolean};

const emptyParticipant=():Participant=>({firstName:"",lastName:"",email:"",phone:"+43 ",birthDate:"",gender:"",allowMarketingMaterials:false,waiver:false,privacy:false,submitted:false});
const copy={
  de:{index:"QuestControl",title:"Check-in",select:"Sicherer Check-in",guests:"Wie viele Gäste möchtest du auf diesem Gerät einchecken?",booked:"gebucht",confirm:"Weiter",details:"Bitte fülle deine Daten aus",participant:"Teilnehmer",progress:"übermittelt",firstName:"Vorname",lastName:"Nachname",email:"E-Mail",phone:"Telefonnummer",birthDate:"Geburtsdatum",birthdayHint:"Geburtsdatum eintragen und eine Geburtstagsüberraschung erhalten 🎁",birthDateError:"Bitte gib ein gültiges Geburtsdatum ein. Das Mindestalter beträgt 10 Jahre.",gender:"Geschlecht",female:"Weiblich",male:"Männlich",diverse:"Nicht-binär",marketing:"Ich möchte Marketing-Neuigkeiten erhalten",waiver:"Ich stimme dem",waiverLabel:"Haftungsausschluss",privacy:"Ich stimme der",privacyLabel:"Datenschutzerklärung",medical:"Bitte sprich vor der Nutzung eines VR-Headsets mit deinem Arzt, wenn du schwanger bist, an einer Herzerkrankung, Epilepsie oder einer anderen relevanten Erkrankung leidest.",next:"Senden & nächste Person",finish:"Check-in abschließen",online:"Online Check-in",scan:"Scannen, um auf einem weiteren Gerät einzuchecken.",group:"Auf diesem Gerät",success:"Der Check-in ist erledigt!",successNote:"Die Daten wurden an Time to Grow übermittelt. Vielen Dank!",queuedNote:"Die Daten wurden gespeichert und werden automatisch an Time to Grow übermittelt, sobald dies möglich ist.",another:"",language:"English",eyebrow:"Self Check-in · Traisenpark",loading:"Sicherer Check-in wird geladen…",empty:"",retry:"Erneut versuchen",loadError:"Der Check-in konnte nicht geladen werden. Bitte erneut versuchen oder unser Team fragen.",sending:"Wird gesendet…",submitError:"Das Formular konnte nicht gesendet werden. Bitte erneut versuchen oder unser Team fragen."},
  en:{index:"QuestControl",title:"Check-in",select:"Secure check-in",guests:"How many guests would you like to check in on this device?",booked:"booked",confirm:"Continue",details:"Please fill out your details",participant:"Participant",progress:"submitted",firstName:"First name",lastName:"Last name",email:"Email",phone:"Phone number",birthDate:"Date of birth",birthdayHint:"Enter your birthday and receive a birthday gift from us 🎁",birthDateError:"Enter a valid date of birth. The minimum age is 10.",gender:"Gender",female:"Female",male:"Male",diverse:"Non-binary",marketing:"I would like to receive marketing updates",waiver:"I agree to the",waiverLabel:"Waiver",privacy:"I agree to the",privacyLabel:"Privacy policy",medical:"Please consult your doctor before using a VR headset if you are pregnant, have a heart condition, epilepsy, or another relevant medical condition.",next:"Submit & next participant",finish:"Complete check-in",online:"Online check-in",scan:"Scan to check in on another device.",group:"On this device",success:"You’re all checked in!",successNote:"The details were sent to Time to Grow. Thank you!",queuedNote:"Your details have been saved and will be sent to Time to Grow automatically as soon as possible.",another:"",language:"Deutsch",eyebrow:"Self Check-in · Traisenpark",loading:"Loading secure check-in…",empty:"",retry:"Try again",loadError:"The check-in could not be loaded. Please try again or ask our team for help.",sending:"Sending…",submitError:"The form could not be submitted. Please try again or ask our team for help."},
};

@Component({
  selector:"app-reception-checkin",
  standalone:true,
  imports:[FormsModule],
  templateUrl:"./reception-checkin.component.html",
  styleUrl:"./reception-checkin.component.css",
})
export class ReceptionCheckinComponent implements OnInit{
  private http=inject(HttpClient);
  private route=inject(ActivatedRoute);
  private checkinToken="";
  language=signal<Language>("de");
  t=computed(()=>copy[this.language()]);
  clubLocation=signal<CheckinLocation>("st-poelten");
  locationName=computed(()=>this.clubLocation()==="vienna"?"Wien":"St. Pölten");
  step=signal<Step>("reservation");
  reservations=signal<Reservation[]>([]);
  documents=signal<CheckinDocuments>({waiver:{},privacy:{}});
  waiverUrl=computed(()=>this.documents().waiver[this.language()]||this.documents().waiver.de||this.documents().waiver.en||"");
  privacyUrl=computed(()=>this.documents().privacy[this.language()]||this.documents().privacy.de||this.documents().privacy.en||"");
  loading=signal(true);
  loadError=signal(false);
  selected=signal<Reservation|null>(null);
  guestCount=signal(1);
  participants=signal<Participant[]>([]);
  participantIndex=signal(0);
  draft=signal<Participant>(emptyParticipant());
  submitting=signal(false);
  hasQueuedParticipants=signal(false);
  submitError=signal(false);
  birthDateError=signal(false);
  qrDataUrl=signal("");
  extraAuthorization=signal("");
  extraError=signal(false);
  authorizingExtra=signal(false);
  hasStaffSession=Boolean(sessionStorage.getItem("access_token"));
  maxBirthDate=this.dateYearsAgo(10);

  ngOnInit(){this.checkinToken=this.route.snapshot.paramMap.get("token")||"";this.extraAuthorization.set(new URLSearchParams(location.search).get("extraAuthorization")||"");this.loadReservation()}
  toggleLanguage(){this.language.update(value=>value==="de"?"en":"de")}
  loadReservation(){
    this.loading.set(true);this.loadError.set(false);
    if(!this.checkinToken){this.loading.set(false);this.loadError.set(true);return}
    const extraQuery=this.extraAuthorization()?`?extraAuthorization=${encodeURIComponent(this.extraAuthorization())}`:"";
    this.http.get<{location:CheckinLocation;data:Reservation;documents:CheckinDocuments}>(`/api/reception/checkin/${encodeURIComponent(this.checkinToken)}${extraQuery}`).subscribe({
      next:payload=>{this.clubLocation.set(payload.location);this.reservations.set([payload.data]);this.documents.set(payload.documents||{waiver:{},privacy:{}});this.selected.set(payload.data);this.guestCount.set(payload.data.guests);this.loading.set(false);this.step.set("guests");this.openFromUrl()},
      error:()=>{this.reservations.set([]);this.documents.set({waiver:{},privacy:{}});this.loading.set(false);this.loadError.set(true)},
    });
  }
  decreaseGuests(){this.extraError.set(false);this.guestCount.update(value=>Math.max(1,value-1))}
  increaseGuests(){
    const reservation=this.selected();if(!reservation||this.authorizingExtra())return;
    const next=this.guestCount()+1;
    if(next<=reservation.maxGuests){this.guestCount.set(next);this.extraError.set(false);return}
    if(!this.hasStaffSession){this.extraError.set(true);return}
    this.authorizingExtra.set(true);this.extraError.set(false);
    this.http.post<{extraAuthorization:string;maxGuests:number}>(`/api/reception/checkin/${encodeURIComponent(this.checkinToken)}/extra-guests`,{totalGuests:next}).subscribe({
      next:payload=>{this.extraAuthorization.set(payload.extraAuthorization);this.selected.update(value=>value?{...value,maxGuests:payload.maxGuests}:value);this.guestCount.set(payload.maxGuests);this.authorizingExtra.set(false)},
      error:()=>{this.authorizingExtra.set(false);this.extraError.set(true)},
    });
  }
  startDetails(){this.participants.set(Array.from({length:this.guestCount()},emptyParticipant));this.participantIndex.set(0);this.draft.set(emptyParticipant());this.submitError.set(false);this.hasQueuedParticipants.set(false);this.step.set("details");void this.refreshQr()}
  updateDraft(patch:Partial<Participant>){this.draft.update(value=>({...value,...patch}));this.submitError.set(false);if("birthDate" in patch)this.birthDateError.set(false)}
  async submitParticipant(){
    const reservation=this.selected();const draft=this.draft();
    if(!reservation||this.submitting()||draft.submitted)return;
    if(!draft.birthDate||draft.birthDate>this.maxBirthDate){this.birthDateError.set(true);return}
    this.submitting.set(true);this.submitError.set(false);
    this.http.post<{synced:boolean}>(`/api/reception/checkin/${encodeURIComponent(this.checkinToken)}/participants`,{firstName:draft.firstName,lastName:draft.lastName,email:draft.email,phone:draft.phone,birthday:draft.birthDate,gender:draft.gender,allowMarketingMaterials:draft.allowMarketingMaterials,acceptWaiver:draft.waiver,acceptPrivacyPolicy:draft.privacy,participantNumber:this.participantIndex()+1,totalGuests:Math.max(reservation.guests,this.guestCount()),extraAuthorization:this.extraAuthorization()}).subscribe({
      next:payload=>{
        if(payload.synced===false)this.hasQueuedParticipants.set(true);
        const updated=[...this.participants()];updated[this.participantIndex()]={...draft,submitted:true};this.participants.set(updated);
        const next=updated.findIndex((participant,index)=>index>this.participantIndex()&&!participant.submitted);
        if(next===-1){this.step.set("done");this.qrDataUrl.set("")}else{this.participantIndex.set(next);this.draft.set(updated[next]);void this.refreshQr()}
        this.submitting.set(false);
      },
      error:()=>{this.submitting.set(false);this.submitError.set(true)},
    });
  }
  private dateYearsAgo(years:number){const date=new Date();date.setFullYear(date.getFullYear()-years);return date.toISOString().slice(0,10)}
  reset(){const url=new URL(location.href);url.search="";history.replaceState({},"",url);this.participants.set([]);this.participantIndex.set(0);this.draft.set(emptyParticipant());this.qrDataUrl.set("");this.extraAuthorization.set("");this.loadReservation()}
  submittedCount(){return this.participants().filter(item=>item.submitted).length}
  submitLabel(){return this.submitting()?this.t().sending:(this.participantIndex()<this.guestCount()-1?this.t().next:this.t().finish)}
  private openFromUrl(){
    const params=new URLSearchParams(location.search);const total=Number(params.get("participants"));
    const reservation=this.selected();
    if(!reservation||!Number.isInteger(total)||total<1||total>reservation.maxGuests)return;
    this.selected.set(reservation);this.guestCount.set(total);this.startDetails();
  }
  private async refreshQr(){
    const reservation=this.selected();if(!reservation)return;
    const url=new URL(location.href);url.search="";if(this.extraAuthorization())url.searchParams.set("extraAuthorization",this.extraAuthorization());
    this.qrDataUrl.set(await QRCode.toDataURL(url.toString(),{width:420,margin:1,errorCorrectionLevel:"M",color:{dark:"#191919",light:"#ffffff"}}));
  }
  isExtraParticipant(index=this.participantIndex()){return index>=(this.selected()?.guests||Number.MAX_SAFE_INTEGER)}
  extraText(kind:"extra"|"approval"|"authorizing"){
    const de={extra:"zusätzlich",approval:"Weitere Gäste müssen von einem Mitarbeiter freigegeben werden.",authorizing:"Wird freigegeben…"};
    const en={extra:"additional",approval:"Additional guests must be approved by a staff member.",authorizing:"Approving…"};
    return (this.language()==="de"?de:en)[kind];
  }
}
