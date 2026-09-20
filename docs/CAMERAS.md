# Камеры LSC Smart Connect / Tuya / RTSP

## LSC Smart Connect через Tuya Cloud

LSC Smart Connect — OEM-экосистема на базе Tuya. Cloud-доступ зависит от конкретной модели, прошивки, региона и того, разрешает ли OEM-приложение LSC привязку к стороннему Tuya Cloud Project. Если аккаунт LSC не связывается, практический вариант — сбросить совместимую камеру и добавить её в Smart Life, но это поддерживается не каждой моделью.

1. Создайте Smart Home Cloud Project в [Tuya Developer Platform](https://platform.tuya.com/) в data center, соответствующем региону аккаунта.
2. Включите `IoT Core`, `Smart Home Basic Service` и `IoT Video Live Stream`.
3. В разделе Devices → Link Tuya App Account отсканируйте QR-код приложением Smart Life. Устройство должно появиться в All Devices.
4. Заполните `TUYA_BASE_URL`, `TUYA_MESSAGE_URL`, `TUYA_CLIENT_ID`, `TUYA_CLIENT_SECRET`.
5. На вкладке **Message Service** включите production-канал и правило `statusReport`, чтобы получать вызовы Doorbell в реальном времени.
6. В QuestControl выберите источник `Tuya Cloud` и сохраните Device ID из All Devices.

API получает Tuya access token сервер-сервер, подписывает запросы HMAC-SHA256, кэширует token в Redis и запрашивает краткоживущий HLS URL. Client Secret никогда не отдаётся frontend. Наличие камеры в LSC/Smart Life не гарантирует поддержку cloud live stream: Tuya указывает требование IPC SDK 4.7.0+ и тарифицирует HLS-трафик после пробной квоты.

## RTSP/ONVIF fallback

Если модель предоставляет RTSP или ONVIF, добавьте поток в `infra/go2rtc.yaml`, а в камере используйте provider `RTSP` и `stream_key`, совпадающий с именем потока. Запускайте профиль: `docker compose --profile cameras up -d`.

В панели откройте «Камеры» → «Добавить камеру» и укажите только `stream_key`. RTSP URL с логином и паролем должен оставаться в закрытом, не попадающем в Git override-файле go2rtc. Nginx публикует только WebRTC/MSE player и signalling endpoint; административный API go2rtc наружу не проксируется.

Для уже созданной базы один раз примените права управления: `docker compose exec -T postgres psql -U quest -d quest_control < infra/postgres/migrations/002-camera-management.sql`. В новой базе они добавляются автоматически.

Рекомендуемая схема: Camera → локальная VLAN → go2rtc на Raspberry/LAN → WireGuard → CRM. Запрещено публиковать порт 554 камеры, go2rtc API или ONVIF в публичный интернет.

MediaMTX можно использовать вместо go2rtc, если нужны запись, ретрансляция и HLS. Для непрерывной записи задайте retention и отдельный диск; доступ к архиву ограничьте отдельным permission.

## Два аккаунта Tuya через локальный Windows-мост

Windows-мост запускает два независимых экземпляра: аккаунт 1 использует UI `8787` и RTSP `8554`, аккаунт 2 — UI `8788` и RTSP `8556`. QuestControl обращается к ним только через приватный OpenConnect-адрес Windows. Для текущей установки это `10.12.0.103`.

Задайте `TUYA_BRIDGE_ACCOUNT_1_API_URL`, `TUYA_BRIDGE_ACCOUNT_1_RTSP_URL` и `GO2RTC_BASE_URL`. Второй аккаунт включается только явно через `TUYA_BRIDGE_ACCOUNT_2_ENABLED=true` вместе с его `API_URL` и `RTSP_URL`. В «Настройки камер» нажмите «Локальный мост». API прочитает `/api/state` активных аккаунтов, зарегистрирует RTSP-источники в go2rtc и создаст камеры с provider `RTSP` и источником `TUYA_LAN_BRIDGE`. Назначение локаций и комнат выполняется после импорта и сохраняется при следующих синхронизациях.
