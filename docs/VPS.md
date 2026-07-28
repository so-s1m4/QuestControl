# Развёртывание на VPS

## Требования

- Ubuntu 22.04/24.04, 2 CPU, 4 GB RAM и 20 GB SSD;
- DNS A/AAAA запись домена на VPS;
- открыты только 22, 80 и 443; PostgreSQL, Redis и agent endpoint наружу отдельными портами не публикуются.

## Порядок

1. Скопируйте проект в `/opt/quest-control`.
2. Создайте `.env` из `.env.example`. Секреты удобно получить через `openssl rand -base64 48`.
3. Замените `server_name _` на ваш домен.
4. Получите сертификат Let's Encrypt и добавьте `listen 443 ssl http2`, пути `ssl_certificate` и `ssl_certificate_key`. HTTP оставьте только для редиректа на HTTPS.
5. Запустите `docker compose up -d --build`.
6. Выполните `docker compose exec api npm run bootstrap`.
7. Создайте agent token: `docker compose exec api npm run provision-agent -- room-lab-01`. Токен показывается один раз.

Резервное копирование: ежедневный `pg_dump`, копия `.env` в защищённом vault и проверка восстановления раз в месяц. Redis содержит временные состояния и токены agent; включён AOF, но PostgreSQL остаётся источником истины.

## WireGuard

WireGuard нужен, если панель должна напрямую открывать сложные локальные сайты или получать RTSP. Пример адресов: VPS `10.20.0.1/24`, Raspberry `10.20.0.2/24`. На Raspberry разрешите доступ к локальному веб-серверу только с `wg0`; не включайте общий IP forwarding без точечных firewall правил.

## Эксплуатация

- `/api/health/live` проверяет процесс;
- `/api/health/ready` проверяет PostgreSQL и Redis;
- обновление: backup, `docker compose build`, затем `docker compose up -d`;
- логи: `docker compose logs --since=30m api nginx`;
- после компрометации agent удалите `agent-token:<id>` из Redis и выпустите новый.
