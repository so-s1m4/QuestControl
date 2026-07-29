# Деплой на OVH через GitHub Actions и Portainer

Схема деплоя:

1. GitHub Actions проверяет API, web и room-agent.
2. После push в `main` собираются Docker-образы API, web, PostgreSQL и gateway.
3. Образы публикуются в GitHub Container Registry (GHCR).
4. GitHub Actions вызывает закрытый webhook Portainer.
5. Portainer загружает свежие образы с тегом `latest` и пересоздаёт Stack.

## 1. Создание Stack

В Portainer откройте **Stacks → Add stack → Repository**:

- Repository URL: URL приватного GitHub-репозитория QuestControl.
- Repository authentication: включить и добавить GitHub Personal Access Token
  только с правом чтения этого репозитория.
- Compose path: `docker-compose.portainer.yml`.
- Automatic updates: включить **Webhook** и сохранить выданный URL.

Для приватных образов добавьте в Portainer Registry `ghcr.io`. Используйте GitHub
логин и token с правом `read:packages`, затем выберите этот Registry для Stack.

## 2. Переменные Stack

Добавьте в Portainer переменные:

```text
REGISTRY_IMAGE_PREFIX=ghcr.io/<github-owner-в-нижнем-регистре>
IMAGE_TAG=latest
HTTP_PORT=10080
HTTPS_PORT=10443
POSTGRES_DB=quest_control
POSTGRES_USER=quest
POSTGRES_PASSWORD=<случайный-секрет>
REDIS_PASSWORD=<другой-случайный-секрет>
JWT_ACCESS_SECRET=<минимум-64-случайных-символа>
JWT_REFRESH_SECRET=<другие-64-случайных-символа>
PSEUDONYMIZATION_SECRET=<отдельный-случайный-секрет>
PUBLIC_URL=https://<домен>
CORS_ORIGIN=https://<домен>
TUYA_BASE_URL=https://openapi.tuyaeu.com
TUYA_CLIENT_ID=<tuya-client-id>
TUYA_CLIENT_SECRET=<tuya-client-secret>
BOOTSTRAP_ADMIN_EMAIL=<email-владельца>
BOOTSTRAP_ADMIN_PASSWORD=<одноразовый-сложный-пароль>
```

Секреты должны находиться только в Portainer. Не добавляйте их в GitHub или
репозиторий без необходимости.

Порты `HTTP_PORT` и `HTTPS_PORT` публикуются только на `127.0.0.1`. Внешний
доступ должен идти через основной reverse proxy сервера по `80/443`.
Stack подключает gateway к существующей внешней Docker-сети `proxy`. В Nginx
Proxy Manager используйте hostname `quest-control` и port `80`.

## 3. GitHub Secret

В **Repository → Settings → Secrets and variables → Actions** добавьте:

- `PORTAINER_WEBHOOK_URL` — закрытый webhook конкретного Stack.

Затем создайте repository variable:

```text
DEPLOY_ENABLED=true
```

До появления этой переменной образы будут собираться, но production deploy будет
пропускаться.

## 4. Первый запуск

Сначала вручную запустите Stack в Portainer. После успешного старта выполните
workflow **Build and deploy → Run workflow** и проверьте:

```bash
curl -fsS https://<домен>/api/health/ready
```

После первого входа смените bootstrap-пароль и удалите
`BOOTSTRAP_ADMIN_PASSWORD` из Stack, если приложение больше не использует его.
