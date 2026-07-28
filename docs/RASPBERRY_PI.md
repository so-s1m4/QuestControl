# Установка Room Agent на Raspberry Pi

1. Установите Node.js 22 LTS.
2. Создайте системного пользователя `quest-agent` без shell.
3. Скопируйте `agents/room-agent` в `/opt/quest-control-room-agent`, выполните `npm install --omit=dev`.
4. Скопируйте `.env.example` в `/etc/quest-control/room-agent.env`, права `600`, владелец root.
5. Впишите одноразовый token, полученный на VPS.
6. Укажите `LOCAL_ORIGINS` только для нужных локальных адресов и `ALLOWED_COMMANDS` только для реально существующих безопасных действий.
7. Установите `quest-room-agent.service` в `/etc/systemd/system`, затем включите сервис.

Agent не слушает входящий порт. Он сам открывает WSS-соединение к `/agent`, отправляет heartbeat и принимает команды с correlation ID. Redirect отключён, protocol и origin проверяются, ответы туннеля ограничены 2 MB.

Существующий сервер комнаты должен самостоятельно обеспечивать аварийное открытие, сценарий, Arduino и сброс даже без VPS. Endpoint команд рекомендуется слушать только на loopback и требовать отдельный локальный token.
