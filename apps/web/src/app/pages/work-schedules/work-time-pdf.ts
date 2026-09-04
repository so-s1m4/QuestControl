import type { TDocumentDefinitions } from "pdfmake/interfaces";

type Entry={user_name:string;arrived_at:string;left_at:string;location_name:string;customer_name:string|null;booking_starts_at:string|null;room_name:string|null;note:string|null};
type Report={generatedAt:string;period:string;entries:Entry[]};
const dt=(value:string)=>new Intl.DateTimeFormat("ru-RU",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"}).format(new Date(value));
const duration=(entry:Entry)=>{const minutes=Math.max(0,Math.round((new Date(entry.left_at).getTime()-new Date(entry.arrived_at).getTime())/60000));return `${Math.floor(minutes/60)} ч ${minutes%60} мин`};
const uniqueMinutes=(entries:Entry[])=>{const groups=new Map<string,Entry[]>();for(const entry of entries){const list=groups.get(entry.user_name)||[];list.push(entry);groups.set(entry.user_name,list)}let total=0;for(const list of groups.values()){const intervals=list.map(e=>[new Date(e.arrived_at).getTime(),new Date(e.left_at).getTime()] as [number,number]).filter(([start,end])=>end>start).sort((a,b)=>a[0]-b[0]);let start=0,end=0;for(const next of intervals){if(!end){[start,end]=next}else if(next[0]<=end){end=Math.max(end,next[1])}else{total+=end-start;[start,end]=next}}if(end)total+=end-start}return Math.round(total/60000)};

export function buildWorkTimePdf(report:Report):TDocumentDefinitions{
  const totalMinutes=uniqueMinutes(report.entries);
  return {pageSize:"A4",pageOrientation:"landscape",pageMargins:[32,34,32,34],defaultStyle:{font:"Roboto",fontSize:8,color:"#344054"},content:[
    {text:"QUESTCONTROL",style:"brand"},{text:"Отчёт по учёту рабочего времени",style:"title"},{text:`${report.period} | Сформирован ${dt(report.generatedAt)}`,style:"subtitle"},
    {columns:[{text:`Записей: ${report.entries.length}`,style:"summary"},{text:`Всего времени без двойного учёта: ${Math.floor(totalMinutes/60)} ч ${totalMinutes%60} мин`,style:"summary"}],margin:[0,16,0,16]},
    {table:{headerRows:1,widths:[90,78,78,58,90,"*",95],body:[
      ["Сотрудник","Пришёл","Ушёл","Итого","Локация","Бронь","Комментарий"].map(text=>({text,style:"head"})),
      ...report.entries.map(e=>[e.user_name,dt(e.arrived_at),dt(e.left_at),duration(e),e.location_name.replace(/_/g," "),e.customer_name?`${e.customer_name}\n${e.booking_starts_at?dt(e.booking_starts_at):""}${e.room_name?` · ${e.room_name}`:""}`:"Без привязки",e.note||"-"])
    ]},layout:{fillColor:(row:number)=>row===0?"#101828":row%2===0?"#f8f9fc":null,hLineColor:()=>"#e4e7ec",vLineColor:()=>"#e4e7ec",paddingLeft:()=>6,paddingRight:()=>6,paddingTop:()=>6,paddingBottom:()=>6}}
  ],styles:{brand:{fontSize:9,bold:true,color:"#4f46e5",characterSpacing:2.2,margin:[0,0,0,7]},title:{fontSize:22,bold:true,color:"#101828",margin:[0,0,0,5]},subtitle:{fontSize:9,color:"#667085"},summary:{fontSize:11,bold:true,color:"#344054"},head:{fontSize:8,bold:true,color:"#fff"}},footer:(page,pages)=>({columns:[{text:"QuestControl | Учёт времени",color:"#98a2b3",fontSize:7},{text:`${page} / ${pages}`,alignment:"right",color:"#98a2b3",fontSize:7}],margin:[32,8,32,0]})};
}
