# Telegram Mini Shop

Магазин-мини-приложение для Telegram с админ-панелью. Стек: Node.js, Express, PostgreSQL, grammY. Деплой: GitHub + Railway.

## Что внутри

- Каталог: поиск, сортировка, категории, карточки «в корзину» и «в избранное», статус «Продано»
- Корзина и оформление заказа (имя, телефон, комментарий)
- Избранное и история заказов в профиле
- Админ-панель (вкладка «Админ» видна только администраторам):
  - товары: добавление, правка, удаление, загрузка нескольких фото
  - заказы: смена статуса, клиент получает уведомление в Telegram
  - категории
- Новый заказ приходит администраторам сообщением от бота
- Каждый товар в единственном экземпляре: после заказа он помечается «Продано», при отмене заказа возвращается в наличие

## Запуск: пошагово

### 1. Создайте бота
1. В Telegram откройте [@BotFather](https://t.me/BotFather) → `/newbot`, получите **токен**.
2. Свой Telegram ID узнайте у [@userinfobot](https://t.me/userinfobot). Это будет `ADMIN_IDS`.

### 2. Загрузите код на GitHub
```bash
cd telegram-mini-shop
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/ВАШ_ЛОГИН/telegram-mini-shop.git
git push -u origin main
```

### 3. Разверните на Railway
1. [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → выберите репозиторий.
2. В проекте нажмите **+ New** → **Database** → **Add PostgreSQL**.
3. Откройте сервис с приложением → **Variables** и добавьте:

| Переменная | Значение |
|---|---|
| `BOT_TOKEN` | токен от BotFather |
| `ADMIN_IDS` | ваш Telegram ID (несколько через запятую) |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `SHOP_NAME` | название магазина (необязательно) |

4. **Settings → Networking → Generate Domain**. Бот сам подхватит адрес из `RAILWAY_PUBLIC_DOMAIN`. Если используете свой домен, задайте `WEBAPP_URL=https://ваш-домен`.
5. Дождитесь деплоя (зелёный статус).

### 4. Проверьте
Откройте бота → `/start` → кнопка «Открыть магазин». У вас появится вкладка **Админ**. Добавьте категории и товары.

Чтобы приложение открывалось и по ссылке `t.me/бот/shop`, в BotFather: `/newapp` → выберите бота → укажите URL с Railway.

## Локальная разработка
```bash
npm install
export DATABASE_URL=postgres://user:pass@localhost:5432/shop
export DEV_USER_ID=123456789   # тест в браузере без Telegram
export ADMIN_IDS=123456789
npm start
```
Откройте http://localhost:3000. `DEV_USER_ID` включает вход без проверки Telegram, на Railway его **не задавайте**.

## Заметки
- Фото хранятся в PostgreSQL (сжимаются до 1200 px в браузере), отдельное хранилище не нужно.
- Бот работает через long polling в том же процессе, запускайте один экземпляр сервиса.
- Оплаты онлайн нет: менеджер связывается с клиентом по контактам из заказа.
