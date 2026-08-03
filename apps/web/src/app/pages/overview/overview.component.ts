import { Component, inject, signal } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { AsyncPipe, DatePipe } from "@angular/common";
import { RouterLink } from "@angular/router";
@Component({selector:"app-overview",standalone:true,imports:[AsyncPipe,DatePipe,RouterLink],template:`
<main><aside><h1>Q <span>QUESTCONTROL</span></h1><nav><a class="active" routerLink="/">Обзор</a><a routerLink="/bookings">Бронирования</a><a class="sessions-nav" routerLink="/sessions">Сессии</a><a routerLink="/locations">Локации</a><a routerLink="/rooms">Комнаты</a><a routerLink="/cameras">Камеры</a><a routerLink="/users">Пользователи</a></nav></aside>
<section><header><div><h2>Центр управления</h2><p>{{today|date:'fullDate'}}</p></div><button routerLink="/bookings">+ Новое бронирование</button></header>
@if(data$|async;as data){<div class="cards"><article><small>Комнат</small><b>{{data.rooms.length}}</b></article><article><small>Бронирований сегодня</small><b>{{data.bookings.length}}</b></article><article><small>Устройства</small><b>{{data.deviceSummary.length}}</b></article></div>
<h3>Комнаты</h3><div class="rooms">@for(room of data.rooms;track room.id){<article><strong>{{room.name}}</strong><span>{{room.kind}} · {{room.live_status||room.status}}</span><button routerLink="/rooms">Открыть комнату</button></article>}</div>}@else{<p>Загрузка центра управления…</p>}
</section></main>`})
export class OverviewComponent{private http=inject(HttpClient);today=new Date();data$=this.http.get<any>("/api/dashboard");command(id:string,action:string){this.http.post(`/api/rooms/${id}/command`,{action,payload:{}}).subscribe();}}
