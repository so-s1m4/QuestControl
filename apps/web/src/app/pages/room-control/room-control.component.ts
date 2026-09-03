import { Component, OnDestroy, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { ActivatedRoute, RouterLink } from "@angular/router";

type Control = { id:string; type:"button"|"checkbox"|"slider"|"indicator"; label:string; statePath?:string; onLabel?:string; offLabel?:string; min?:number; max?:number; step?:number; unit?:string };
type Manifest = { version:1; title:string; state?:{pollMs:number}; blocks:{id:string;title:string;width:"full"|"half"|"third";categories:{id:string;title:string;controls:Control[]}[]}[] };

@Component({
  selector:"app-room-control",standalone:true,imports:[RouterLink],
  template:`<main class="panel-shell">
    <header><div><a routerLink="/rooms">← Комнаты</a><span>ROOM CONTROL</span><h1>{{manifest()?.title||"Панель комнаты"}}</h1></div><i [class.online]="online()">{{online()?"ONLINE":"OFFLINE"}}</i></header>
    @if(error()){<section class="empty"><b>Панель недоступна</b><p>{{error()}}</p><button (click)="load()">Повторить</button></section>}
    @else if(!manifest()){<section class="empty"><b>Загружаем конфигурацию room-agent…</b></section>}
    @else {<div class="blocks">
      @for(block of manifest()!.blocks;track block.id){<article class="block" [class.full]="block.width==='full'" [class.third]="block.width==='third'">
        <h2>{{block.title}}</h2>
        @for(category of block.categories;track category.id){<section class="category"><h3>{{category.title}}</h3><div class="controls">
          @for(control of category.controls;track control.id){
            @if(control.type==='button'){<button [disabled]="busy()===control.id" (click)="execute(control)">{{busy()===control.id?'Выполняется…':control.label}}</button>}
            @else if(control.type==='checkbox'){<label class="check"><span><b>{{control.label}}</b><small>{{boolValue(control)?(control.onLabel||'Включено'):(control.offLabel||'Выключено')}}</small></span><button role="switch" [class.on]="boolValue(control)" [disabled]="busy()===control.id" (click)="execute(control,!boolValue(control))"><i></i></button></label>}
            @else if(control.type==='slider'){<label class="range"><span><b>{{control.label}}</b><output>{{numberValue(control)}}{{control.unit||''}}</output></span><input type="range" [min]="control.min??0" [max]="control.max??100" [step]="control.step??1" [value]="numberValue(control)" [disabled]="busy()===control.id" (change)="execute(control,undefined,+$any($event.target).value)"></label>}
            @else {<div class="indicator" [class.ok]="boolValue(control)"><i></i><span><b>{{control.label}}</b><small>{{boolValue(control)?(control.onLabel||'Норма'):(control.offLabel||'Не сработал')}}</small></span></div>}
          }
        </div></section>}
      </article>}
    </div>}
  </main>`,
  styles:[`:host{display:block;min-height:100vh;background:#f4f6fb;color:#151b2b}.panel-shell{max-width:1500px;margin:auto;padding:28px}header{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px}header a{display:block;margin-bottom:18px;color:#5662d9;text-decoration:none;font-weight:700}header span{color:#7a8498;font-size:11px;font-weight:800;letter-spacing:.14em}h1{margin:5px 0;font-size:34px}header>i{padding:9px 12px;border-radius:999px;background:#feecef;color:#a62938;font-style:normal;font-size:11px;font-weight:800}header>i.online{background:#e5f8ed;color:#087443}.blocks{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:16px}.block{grid-column:span 3;padding:20px;border:1px solid #dfe3eb;border-radius:18px;background:#fff;box-shadow:0 8px 25px #26324c0a}.block.full{grid-column:1/-1}.block.third{grid-column:span 2}.block h2{margin:0 0 18px;font-size:21px}.category+.category{margin-top:20px;padding-top:18px;border-top:1px solid #e7e9ef}.category h3{margin:0 0 10px;color:#667085;font-size:11px;letter-spacing:.08em;text-transform:uppercase}.controls{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.controls>button{min-height:48px;border:0;border-radius:11px;background:#5462e8;color:#fff;font-weight:750}.check,.range,.indicator{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 14px;border-radius:12px;background:#f5f7fa}.check b,.check small,.indicator b,.indicator small{display:block}.check small,.indicator small{margin-top:4px;color:#7b8494;font-size:11px}.check>button{position:relative;width:48px;height:28px;padding:0;border:0;border-radius:20px;background:#c5cad4}.check>button i{position:absolute;top:4px;left:4px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.15s}.check>button.on{background:#5462e8}.check>button.on i{left:24px}.range{display:grid}.range>span{display:flex;justify-content:space-between}.range input{width:100%;accent-color:#5462e8}.indicator{justify-content:flex-start}.indicator>i{width:12px;height:12px;border-radius:50%;background:#d04455}.indicator.ok>i{background:#13a266}.empty{padding:60px;border:1px solid #dfe3eb;border-radius:18px;background:#fff;text-align:center}.empty p{color:#667085}@media(max-width:900px){.block,.block.third{grid-column:1/-1}}@media(max-width:600px){.panel-shell{padding:18px 12px 90px}h1{font-size:27px}.controls{grid-template-columns:1fr}.controls>*{grid-column:1!important}}`]
})
export class RoomControlComponent implements OnDestroy {
  private http=inject(HttpClient); private roomId=inject(ActivatedRoute).snapshot.paramMap.get("id")||""; private timer?:ReturnType<typeof setInterval>;
  manifest=signal<Manifest|null>(null); state=signal<Record<string,unknown>>({}); error=signal(""); online=signal(false); busy=signal("");
  constructor(){this.load();}
  load(){this.error.set("");this.http.get<Manifest>(`/api/rooms/${this.roomId}/control-panel/manifest`).subscribe({next:m=>{this.manifest.set(m);this.refresh();clearInterval(this.timer);this.timer=setInterval(()=>this.refresh(),m.state?.pollMs||2000)},error:e=>this.error.set(e.error?.error==="AGENT_NOT_CONFIGURED"?"К комнате не подключён room-agent.":"Room-agent не вернул /api/room-config.")});}
  refresh(){this.http.get<Record<string,unknown>>(`/api/rooms/${this.roomId}/control-panel/state`).subscribe({next:s=>{this.state.set(s);this.online.set(true)},error:()=>this.online.set(false)});}
  value(control:Control){return (control.statePath||"").split(".").filter(Boolean).reduce<any>((value,key)=>value?.[key],this.state());}
  boolValue(control:Control){const value=this.value(control);return value===true||value===1||String(value).toLowerCase()==="on"||String(value).toLowerCase()==="true";}
  numberValue(control:Control){const value=Number(this.value(control));return Number.isFinite(value)?value:(control.min??0);}
  execute(control:Control,checked?:boolean,value?:number){this.busy.set(control.id);const body=control.type==="checkbox"?{checked}:{...(control.type==="slider"?{value}:{})};this.http.post(`/api/rooms/${this.roomId}/control-panel/actions/${control.id}`,body).subscribe({next:()=>{this.busy.set("");this.refresh()},error:()=>{this.busy.set("");alert("Команда не выполнена.")}});}
  ngOnDestroy(){clearInterval(this.timer);}
}
