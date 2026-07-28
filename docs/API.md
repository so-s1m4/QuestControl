# Основные API

- `POST /api/auth/login`, `POST /api/auth/refresh`
- `GET /api/dashboard`
- `GET /api/{locations|rooms|integrations|local_sites|cameras|devices|bookings|sessions}`
- `POST /api/bookings`
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
