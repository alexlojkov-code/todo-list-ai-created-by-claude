# To do list с AI-приоритезацией

Список дел, который умеет расставлять приоритеты задачам с помощью Claude. Подробности — в [SPEC.md](SPEC.md).

> Проект целиком создан **Claude** (Anthropic) в Claude Code.

**Сайт:** https://todo-list-ai-three.vercel.app · **Код:** https://github.com/alexlojkov-code/todo-list-ai-created-by-claude

Дизайн: узкий гротеск Oswald заглавными в заголовках, JetBrains Mono в тексте, графитовые линии и красные акценты, прямые углы. Есть светлая и тёмная тема.

Приложение работает в двух режимах:
- **без аккаунта** — задачи хранятся только в браузере (`localStorage`);
- **с аккаунтом** — регистрация и вход по email и паролю, задачи синхронизируются между устройствами.

Без API-ключа AI выключен, всё остальное работает. С ключом AI доступен вошедшим пользователям.

## Редизайн «Тихий час»

Идёт в ветке `redesign` по плану [REDESIGN-PLAN.md](REDESIGN-PLAN.md) (правила оформления — [DESIGN-SYSTEM.md](DESIGN-SYSTEM.md)).

- Точка отката — метка `before-redesign`. Опубликованный сайт собирается из `main` и не меняется до выпуска.
- Для проверок используется отдельная ветка базы Neon `redesign` (локальный `.env` и предварительные сборки Vercel). Рабочая база — только у опубликованного сайта.
- Эталонные снимки до редизайна — `docs/before/`, после — `docs/after/`.

## Как устроено

Так же, как в NutriLens:

- **Vercel** раздаёт `public/` и запускает функции из `api/` (Node.js 22, регион `cle1`). Проект `todo-list-ai`.
- **Neon** — база Postgres `TODO-LIST` (`lively-night-36625317`): таблицы `users`, `sessions`, `user_data` (задачи целиком в `jsonb` с номером версии).
- Пароли — `scrypt` со случайной солью. Сессия — случайный токен в cookie `HttpOnly; Secure; SameSite=Lax`, в базе хранится только его SHA-256.
- Изменяющие запросы принимаются только со своего сайта (заголовок `x-td` и проверка `Origin`).
- После 5 неверных паролей вход блокируется на 15 минут.
- Синхронизация: правки отправляются через ~1 с; если задачи уже изменены на другом устройстве (ответ 409), они объединяются и отправляются снова.

| Метод | Путь | Что делает |
|---|---|---|
| POST | `/api/auth/register` | регистрация и вход |
| POST | `/api/auth/login` | вход |
| POST | `/api/auth/logout` | выход |
| GET | `/api/auth/me` | кто вошёл |
| POST | `/api/auth/password` | смена пароля (остальные устройства выходят) |
| GET / PUT | `/api/data` | загрузить / сохранить задачи |
| DELETE | `/api/account` | удалить аккаунт и все задачи |
| GET | `/api/ai/status` | включён ли AI (ключ не возвращается) |
| POST | `/api/ai/prioritize` | расставить приоритеты |

## Запуск и публикация

Нужен Node.js 22+. CLI можно не ставить глобально — подойдёт `npx vercel` и `npx neonctl` (вход: `npx vercel login`, `npx neonctl auth`).

```bash
npm install
```

```bash
npx neonctl connection-string --project-id lively-night-36625317
```

Строку подключения вписать в `.env` как `DATABASE_URL=...`, затем:

```bash
npm run migrate
```

```bash
npm run dev
```

Открыть http://localhost:3000. Опубликовать:

```bash
npx vercel deploy --prod
```

Без `DATABASE_URL` сервер тоже работает — просто без аккаунтов.

## Включить AI

1. Получить ключ в [Anthropic Console](https://console.anthropic.com).
2. Локально: вписать в `.env` строку `ANTHROPIC_API_KEY=sk-ant-...` и перезапустить `npm run dev`.
3. На сайте: добавить ключ в переменные проекта Vercel и опубликовать заново:

```bash
npx vercel env add ANTHROPIC_API_KEY production --sensitive
```

Для разработки без ключа можно поставить `AI_PROVIDER=mock`: приоритеты будет расставлять локальная эвристика по сроку и ключевым словам, без запросов в сеть.

## Настройки

| Переменная | По умолчанию | Описание |
|---|---|---|
| `DATABASE_URL` | пусто | Строка подключения к Neon. Пусто — без аккаунтов |
| `AI_PROVIDER` | `anthropic` | `anthropic`, `mock` или `none` |
| `ANTHROPIC_API_KEY` | пусто | Ключ API. Пусто — AI выключен |
| `AI_MODEL` | `claude-opus-5-5` | Модель Claude |
| `AI_TIMEOUT_MS` | `30000` | Таймаут запроса к AI |
| `PORT` | `3000` | Порт локального сервера |

## Файлы

```
api/                функции Vercel
  ai/               status.js, prioritize.js
  auth/             register.js, login.js, logout.js, me.js, password.js
  data.js           задачи пользователя
  account.js        удаление аккаунта
  _lib/server.js    база, пароли, сессии, ответы
  _lib/config.js    переменные окружения
  _lib/ai/          provider.js, anthropic.js (Claude), mock.js, disabled.js
scripts/dev.mjs     локальный сервер: public/ + api/
scripts/migrate.mjs создание таблиц
public/             index.html, style.css, app.js, cloud.js (аккаунт и синхронизация)
```
