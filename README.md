# QuestControl MVP

Рабочая основа CRM и Control Center для реальных и VR-квестов. В репозитории есть Angular-панель, Node.js API, PostgreSQL, Redis, Socket.IO, Nginx, исходящий Raspberry Pi agent и два пути подключения камер: Tuya Cloud и локальный RTSP/ONVIF.

## Что реализовано

- JWT access/refresh авторизация, Argon2, rate limiting, security headers;
- RBAC с ролями Owner, Admin, Operator и Technician;
- комнаты, локации, бронирования, сессии, устройства, камеры, интеграции и локальные сайты;
- контроль конфликтов бронирований;
- команды комнате с подтверждением результата через Socket.IO;
- одноразовый 60-секундный туннель к разрешённой локальной панели;
- agent без входящих портов, allowlist URL и команд, лимит ответа 2 MB;
- аудит действий с actor, IP, user-agent, request ID и снимками состояния;
- live/readiness health checks;
- Docker Compose и reverse proxy;
- профиль `cameras` с go2rtc.

## Быстрый запуск на VPS

1. Установите Docker Engine и Compose plugin.
2. Скопируйте `.env.example` в `.env`, замените все секреты и укажите домен.
3. Добавьте TLS-сертификаты и HTTPS server block в `infra/nginx/default.conf` (пример в `docs/VPS.md`).
4. Запустите `docker compose up -d --build`.
5. Создайте владельца: `docker compose exec api npm run bootstrap`.
6. Проверьте `/api/health/ready`.

Для production-деплоя через GitHub Actions, GHCR и Portainer используйте
`docker-compose.portainer.yml` и инструкцию
[`docs/DEPLOY_OVH_PORTAINER.md`](docs/DEPLOY_OVH_PORTAINER.md).

## Telegram-уведомления

Создайте бота через @BotFather и добавьте его новый токен в `TELEGRAM_BOT_TOKEN` файла `.env`; имя бота без `@` добавьте в `TELEGRAM_BOT_USERNAME`. После перезапуска API владелец сможет отредактировать шаблоны в разделе «Интеграции», а каждый сотрудник — привязать личный Telegram в разделе «Telegram». Токен не должен попадать в Git или в настройки, доступные через браузер.

Для локальной проверки можно временно оставить HTTP и `CORS_ORIGIN=http://localhost`.

## Raspberry Pi

Полная инструкция находится в `docs/RASPBERRY_PI.md`. Agent устанавливается отдельно, соединяется с VPS наружу по WSS, вызывает только разрешённые команды существующего локального сайта и продолжает переподключаться после потери сети.

## Камеры

См. `docs/CAMERAS.md`. LSC Smart Connect обычно использует экосистему Tuya, но доступ конкретной модели к cloud streaming нужно проверить в Tuya IoT Platform. Если у камеры есть RTSP/ONVIF, используйте go2rtc или MediaMTX локально. Не публикуйте RTSP и go2rtc API в интернет.

## Границы MVP

Туннель предназначен для GET-страниц и небольших ресурсов. Полноценное интерактивное зеркало сайта (WebSocket, формы, большие видео, переписывание ссылок) требует отдельного streaming reverse-proxy протокола. Для постоянного доступа к сложной локальной панели используйте WireGuard и Nginx с RBAC. Tuya cloud credentials и RTSP credentials не должны храниться в открытых JSON-полях БД; в production подключите KMS/Vault к `encrypted_config`.
