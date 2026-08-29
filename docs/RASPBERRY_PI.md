# Установка Room Agent на Raspberry Pi

1. Установите Node.js 22 LTS и аудиоплеер: `sudo apt install ffmpeg alsa-utils`.
2. Создайте системного пользователя `quest-agent` без shell.
3. Скопируйте `agents/room-agent` в `/opt/quest-control-room-agent`, выполните `npm install --omit=dev`.
4. Скопируйте `.env.example` в `/etc/quest-control/room-agent.env`, права `600`, владелец root.
5. Впишите одноразовый token, полученный на VPS.
6. Укажите `LOCAL_ORIGINS` только для нужных локальных адресов и `ALLOWED_COMMANDS` только для реально существующих безопасных действий.
7. Установите `quest-room-agent.service` в `/etc/systemd/system`, затем включите сервис.

Agent не слушает входящий порт. Он сам открывает WSS-соединение к `/agent`, отправляет heartbeat и принимает команды с correlation ID. Redirect отключён, protocol и origin проверяются, ответы туннеля ограничены 2 MB.

Существующий сервер комнаты должен самостоятельно обеспечивать аварийное открытие, сценарий, Arduino и сброс даже без VPS. Endpoint команд рекомендуется слушать только на loopback и требовать отдельный локальный token.

## Krampus House

Для панели Krampus имя комнаты в QuestControl должно содержать `Krampus`, а хотя бы одно
устройство этой комнаты — иметь `agent_id`, совпадающий с `AGENT_ID` агента. Не используйте
один `agent_id` одновременно для нескольких комнат.

В `LOCAL_ORIGINS` добавьте origin локального Krampus-сервера (обычно
`http://127.0.0.1:3000`). Agent обращается только к следующим маршрутам:

- `GET /api/status`, `GET /api/sensors`, `GET /api/serial/tail`;
- `POST /api/serial/config` с JSON `{ "path": "/dev/ttyUSB0" }` для ручного выбора Arduino;
- `POST /api/admin` с JSON `{ "cmd": "ADMIN …" }`;
- `POST /api/sound/play` с разрешённым именем файла и `POST /api/sound/stop`.

Панель разрешает фиксированный набор административных команд и два звука:
`alert.mp3` и `calling.mp3`. Произвольная строка из браузера не передаётся на Arduino.
Проверьте локальные endpoints до запуска systemd:

```sh
curl --fail http://127.0.0.1:3000/api/status
curl --fail http://127.0.0.1:3000/api/sensors
curl --fail http://127.0.0.1:3000/api/serial/tail
```

Локальный сервер должен применить новый порт из `/api/serial/config`, переподключить
serial и сохранить выбор после перезапуска. Типичный порт клона Arduino с USB-UART
CH340/CP210x — `/dev/ttyUSB0`; для CDC-плат часто используется `/dev/ttyACM0`.

Затем проверьте `systemctl status quest-room-agent` и появление устройства в QuestControl
со статусом `ONLINE`. `Agent online` означает доступность локального API через agent,
а `Arduino online` — значение `serial.enabled` из `/api/status`.

### Голосовая связь

Кнопка «Удерживайте для разговора» передаёт Opus-аудио с микрофона оператора через
защищённый Socket.IO-канал. API повторно проверяет JWT, право `devices:command` и доступ
оператора к локации. Поток не сохраняется на VPS и прекращается при отпускании кнопки,
закрытии страницы или потере соединения.

По умолчанию agent воспроизводит поток через `ffplay`. Системный сервис уже добавляет
пользователя `quest-agent` в группу `audio`. Проверьте звук от имени этого пользователя:

```sh
sudo -u quest-agent aplay /usr/share/sounds/alsa/Front_Center.wav
```

Если используется не default ALSA-выход, задайте его в `AUDIO_DEVICE`, например
`AUDIO_DEVICE=plughw:1,0`. Альтернативно установите `mpv` и укажите
`AUDIO_PLAYER=mpv` с именем выхода, поддерживаемым параметром `mpv --audio-device`.
После изменения `.env` или service-файла выполните:

```sh
sudo systemctl daemon-reload
sudo systemctl restart quest-room-agent
```

Доступ к микрофону браузер разрешает только на HTTPS (исключение — localhost), поэтому
production-панель QuestControl должна открываться по HTTPS.

### Записанные голосовые подсказки

В панели Krampus оператор может загрузить и назвать готовые записи в форматах MP3,
WAV, OGG, WebM и M4A размером до 6 МБ. Файлы хранятся на VPS и передаются в agent
только при нажатии кнопки «Отправить»; вручную копировать их на Raspberry Pi не нужно.
Для воспроизведения используется тот же `AUDIO_PLAYER` и `AUDIO_DEVICE`, что и для
голосовой связи.

При обновлении agent распакуйте новый архив и повторно запустите `install-on-pi.sh`.
На вопрос о найденной конфигурации выберите сохранение без изменений. Установщик
обновит файлы agent, зависимости и перезапустит systemd-сервис.
