# Основные API

- `POST /api/auth/login`, `POST /api/auth/refresh`
- `GET /api/dashboard`
- `GET /api/{locations|rooms|integrations|local_sites|cameras|devices|bookings|sessions}`
- `POST /api/bookings`
- `POST /api/bookings/:id/participants` — привязать псевдонимизированных участников к брони; email используется только для HMAC и не сохраняется (требует `PSEUDONYMIZATION_SECRET`)
- `POST /api/sessions` — запустить сессию и зафиксировать состав/категории участников на момент игры
- `GET /api/statistics/players?from=YYYY-MM-DD&to=YYYY-MM-DD` — игроки, уникальные посетители, сессии и разбивка по категории, возрастной группе и игре
- `GET /api/time-to-grow/clubs`
- `GET /api/time-to-grow/bookings?date=YYYY-MM-DD&clubId=...` — подтверждённые бронирования Time to Grow (требует `TIME_TO_GROW_EMAIL`/`TIME_TO_GROW_PASSWORD` либо `TIME_TO_GROW_JWT`)
- `POST /api/time-to-grow/import` — идемпотентно импортировать одну бронь или набор дат, псевдонимизировать участников и при необходимости создать завершённые исторические сессии
- `POST /api/rooms/:id/command`
- `POST /api/local-sites/:id/tunnel`, затем одноразовый `GET /api/tunnel/:ticket`
- `GET /api/cameras/:id/stream`
- `POST /api/cameras` — создать RTSP/ONVIF/Tuya запись (`cameras:manage`)
- `PATCH /api/cameras/:id` — изменить камеру (`cameras:manage`)
- `DELETE /api/cameras/:id` — удалить камеру (`cameras:manage`)
- `GET /api/health/live`, `GET /api/health/ready`

Команда комнаты:

```json
{"action":"start_game","payload":{"bookingId":"uuid"}}
```

Разрешённые actions: `status`, `start_game`, `pause_game`, `reset_room`, `send_hint`, `add_time`, `end_game`.

## Псевдонимизированные участники

```json
{
  "participants": [
    {
      "email": "player@example.com",
      "role": "PLAYER",
      "category": "FAMILY",
      "ageBand": "ADULT"
    }
  ]
}
```

`email` может быть `null`: такой участник учитывается в общей посещаемости, но не используется
для определения повторных визитов. Допустимые возрастные группы: `CHILD`, `TEEN`, `ADULT`, `UNKNOWN`. Полная дата рождения,
имя и исходный email в таблицы истории не записываются. Для production задайте отдельный
случайный `PSEUDONYMIZATION_SECRET` длиной не менее 32 символов и не храните его в базе данных.
