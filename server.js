import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { Bot, InlineKeyboard, InputFile } from 'grammy';

pg.types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC -> number
pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const numOr = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const SHOP_NAME = process.env.SHOP_NAME || 'LOT24';
const CHANNEL = (process.env.CHANNEL || '').trim().replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '');
// куда постить новые лоты: числовой CHANNEL_ID (для приватных каналов) или @username из CHANNEL
// id канала запоминается в БД (когда бот добавлен админом / командой /setchannel), иначе берём CHANNEL_ID или @CHANNEL
let channelChat = process.env.CHANNEL_ID ? Number(process.env.CHANNEL_ID) : CHANNEL ? '@' + CHANNEL : null;
const POST_TO_CHANNEL = process.env.POST_TO_CHANNEL !== 'false';
const APP_SHORT_NAME = (process.env.APP_SHORT_NAME || '').trim(); // короткое имя Mini App из BotFather (необязательно)
const DEV_USER_ID = process.env.DEV_USER_ID ? Number(process.env.DEV_USER_ID) : null;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
const TZ = process.env.TZ_NAME || 'Europe/Minsk';

// сроки торгов и их стоимость в звёздах (24 ч — бесплатно)
const DURATIONS = [
  { hours: 24, stars: numOr(process.env.PRICE_24H, 0) },
  { hours: 48, stars: numOr(process.env.PRICE_48H, 10) },
  { hours: 72, stars: numOr(process.env.PRICE_72H, 15) },
];
const BUMP_STARS = numOr(process.env.BUMP_STARS, 25); // поднятие лота
const MAX_STEP = numOr(process.env.MAX_STEP, 10); // максимальный шаг ставки, BYN
const ANTI_SNIPE_MIN = numOr(process.env.ANTI_SNIPE_MIN, 5); // ставка в последние N минут продлевает торги (0 — выключено)
const ANTI_SNIPE_MAX_EXT = 12;
const DIGEST_HOUR = numOr(process.env.DIGEST_HOUR, 18); // час ежедневного дайджеста (по времени TZ_NAME)

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
if (!BOT_TOKEN && !DEV_USER_ID) { console.error('BOT_TOKEN is not set'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

// Миграции только добавляют: CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
// Данные (лоты, ставки, фото) никогда не удаляются при обновлении кода.
async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS images ( id SERIAL PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL );
    ALTER TABLE images ADD COLUMN IF NOT EXISTS owner BIGINT;
    ALTER TABLE images ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();

    CREATE TABLE IF NOT EXISTS auctions (
      id SERIAL PRIMARY KEY,
      seller_id BIGINT NOT NULL,
      seller_name TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      size TEXT NOT NULL DEFAULT '',
      city TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      image_ids INTEGER[] NOT NULL DEFAULT '{}',
      start_price NUMERIC(10,2) NOT NULL,
      min_step NUMERIC(10,2) NOT NULL,
      max_step NUMERIC(10,2) NOT NULL,
      current_price NUMERIC(10,2) NOT NULL,
      bids_count INTEGER NOT NULL DEFAULT 0,
      leader_id BIGINT,
      leader_name TEXT,
      status TEXT NOT NULL DEFAULT 'draft', -- draft | active | ended | cancelled
      pay_method TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      bumped_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS auctions_status_idx ON auctions(status, ends_at);
    ALTER TABLE auctions ADD COLUMN IF NOT EXISTS duration_hours INTEGER NOT NULL DEFAULT 24;
    ALTER TABLE auctions ADD COLUMN IF NOT EXISTS extensions INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE auctions ADD COLUMN IF NOT EXISTS notified_1h BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE auctions ADD COLUMN IF NOT EXISTS notified_15m BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE auctions ADD COLUMN IF NOT EXISTS channel_chat TEXT;
    ALTER TABLE auctions ADD COLUMN IF NOT EXISTS channel_msg_id BIGINT;

    CREATE TABLE IF NOT EXISTS bids (
      id SERIAL PRIMARY KEY,
      auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
      user_id BIGINT NOT NULL,
      user_name TEXT NOT NULL DEFAULT '',
      amount NUMERIC(10,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS bids_auction_idx ON bids(auction_id, id DESC);
    CREATE INDEX IF NOT EXISTS bids_user_idx ON bids(user_id);

    CREATE TABLE IF NOT EXISTS auction_favorites (
      user_id BIGINT NOT NULL,
      auction_id INTEGER NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, auction_id)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      kind TEXT NOT NULL,           -- list | bump
      auction_id INTEGER,
      method TEXT NOT NULL,         -- stars | admin | free
      amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      charge_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS users (
      user_id BIGINT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      username TEXT,
      notify BOOLEAN NOT NULL DEFAULT true,
      blocked BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS meta ( key TEXT PRIMARY KEY, value TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now() );

    -- старые лоты «на проверке» (ручная оплата BYN убрана) возвращаем в черновики
    UPDATE auctions SET status='draft' WHERE status='pending_review';
  `);
}

// ---------- helpers ----------
const clean = (v, n) => String(v ?? '').trim().slice(0, n);
const cents = (v) => Math.round(Number(v) * 100);
const money = (v) => Math.round(Number(v) * 100) / 100;
const num = (v) => money(String(v ?? '').replace(',', '.'));
const fmt = (v) => new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(v);
const h = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const userLink = (id, name) => `<a href="tg://user?id=${id}">${h(name || 'пользователь')}</a>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtDate = (d) => new Date(d).toLocaleString('ru-RU', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function leftHuman(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(m / 1440), hh = Math.floor((m % 1440) / 60), mm = m % 60;
  if (d > 0) return `${d} д ${hh} ч`;
  if (hh > 0) return `${hh} ч ${mm} мин`;
  return `${mm} мин`;
}
const priceOf = (hours) => (DURATIONS.find((d) => d.hours === Number(hours)) || DURATIONS[0]).stars;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: 'Ошибка сервера' });
  });

// ---------- Telegram initData ----------
function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const str = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  const a = Buffer.from(calc);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date') || 0) > 60 * 60 * 24 * 7) return null;
  try { return JSON.parse(params.get('user')); } catch { return null; }
}

// ---------- обязательная подписка на канал ----------
const REQUIRE_SUB = process.env.REQUIRE_SUBSCRIPTION !== 'false';
const subCache = new Map(); // userId -> { ok, at }
async function isSubscribed(userId) {
  if (!REQUIRE_SUB || !channelChat || !bot) return true;
  if (ADMIN_IDS.includes(Number(userId))) return true;
  const c = subCache.get(userId);
  if (c && Date.now() - c.at < (c.ok ? 5 * 60 * 1000 : 3 * 1000)) return c.ok;
  try {
    const m = await bot.api.getChatMember(channelChat, userId);
    const ok = ['creator', 'administrator', 'member'].includes(m.status) || (m.status === 'restricted' && m.is_member);
    subCache.set(userId, { ok, at: Date.now() });
    return ok;
  } catch (e) {
    console.error('getChatMember', e.message); // бот не админ канала и т.п. — не блокируем всех
    return true;
  }
}

async function auth(req, res, next) {
  let user = validateInitData(req.get('X-Init-Data'));
  if (!user && DEV_USER_ID) user = { id: DEV_USER_ID, first_name: 'Dev', username: 'dev' };
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  req.isAdmin = ADMIN_IDS.includes(Number(user.id));
  const dn = clean([user.first_name, user.last_name].filter(Boolean).join(' '), 40);
  req.displayName = /[\p{L}\p{N}]/u.test(dn) ? dn : clean(user.username, 40) || 'Участник';
  if (!req.originalUrl.startsWith('/api/me') && !(await isSubscribed(user.id))) {
    return res.status(403).json({ error: 'not_subscribed' });
  }
  next();
}
function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  next();
}

async function touchUser(u, unblock = false) {
  if (!u?.id) return;
  const name = clean([u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '', 80);
  await q(
    `INSERT INTO users(user_id, name, username) VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO UPDATE SET name=EXCLUDED.name, username=EXCLUDED.username, last_seen=now(),
       blocked = CASE WHEN $4 THEN false ELSE users.blocked END`,
    [u.id, name, u.username || null, unblock]
  );
}

// ---------- bot helpers ----------
let bot = null;
let botUsername = null;

const lotLink = (id) => {
  if (!botUsername) return null;
  return APP_SHORT_NAME
    ? `https://t.me/${botUsername}/${APP_SHORT_NAME}?startapp=lot_${id}`
    : `https://t.me/${botUsername}?start=lot_${id}`;
};
const botLink = () => (botUsername ? `https://t.me/${botUsername}` : null);
const lotKb = (id, text = '🔨 Открыть лот') => (WEBAPP_URL ? { reply_markup: new InlineKeyboard().webApp(text, `${WEBAPP_URL}?lot=${id}`) } : {});
const openAppKb = () => (WEBAPP_URL ? { reply_markup: new InlineKeyboard().webApp('Открыть аукцион', WEBAPP_URL) } : {});

async function notify(userId, html, extra = {}) {
  if (!bot || !userId) return false;
  try {
    await bot.api.sendMessage(userId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
    return true;
  } catch (e) {
    if (e.error_code === 403) await q('UPDATE users SET blocked=true WHERE user_id=$1', [userId]).catch(() => {});
    else console.error('notify failed', userId, e.message);
    return false;
  }
}
const notifyAdmins = (html) => Promise.allSettled(ADMIN_IDS.map((id) => notify(id, html)));

async function lotPhoto(a) {
  if (!a.image_ids?.length) return null;
  const { rows } = await q('SELECT data FROM images WHERE id=$1', [a.image_ids[0]]);
  return rows[0] ? new InputFile(rows[0].data, 'lot.jpg') : null;
}

function lotCaption(a, extra = '') {
  let t = `🔨 <b>${h(a.title)}</b>\n\n`;
  t += `📏 Размер: ${h(a.size)}\n📍 Встреча: ${h(a.city)}\n`;
  t += `💰 Старт: ${fmt(a.start_price)} BYN · шаг ${fmt(a.min_step)}–${fmt(a.max_step)} BYN\n`;
  t += `⏱ Торги до ${fmtDate(a.ends_at)} (${TZ.split('/').pop()})\n`;
  if (a.description) t += `\n${h(a.description.slice(0, 250))}${a.description.length > 250 ? '…' : ''}\n`;
  if (extra) t += `\n${extra}`;
  return t;
}

// ---------- канал ----------
const chatErrHint = (msg) =>
  /chat not found/i.test(msg)
    ? 'Канал не найден. Проверьте переменную CHANNEL (username канала, без @ и без ссылки; у приватного канала username нет — тогда задайте CHANNEL_ID) и добавьте бота в канал администратором. Быстрый способ: отправьте боту /setchannel @username_канала'
    : /not enough rights|administrator|forbidden/i.test(msg)
      ? 'У бота нет прав: сделайте его администратором канала с правом публикации сообщений.'
      : '';

async function postLotToChannel(a, { warn = true } = {}) {
  if (!bot || !channelChat || !POST_TO_CHANNEL) return { ok: false, error: 'Канал не настроен (переменная CHANNEL или /setchannel)' };
  try {
    const link = lotLink(a.id);
    const kb = new InlineKeyboard();
    if (link) kb.url('🔨 Сделать ставку', link);
    const caption = lotCaption(a, link ? `👉 <a href="${link}">Открыть лот и сделать ставку</a>` : '');
    const photo = await lotPhoto(a);
    const opts = { caption, parse_mode: 'HTML', ...(link ? { reply_markup: kb } : {}) };
    const msg = photo
      ? await bot.api.sendPhoto(channelChat, photo, opts)
      : await bot.api.sendMessage(channelChat, caption, { parse_mode: 'HTML', ...(link ? { reply_markup: kb } : {}) });
    await q('UPDATE auctions SET channel_chat=$2, channel_msg_id=$3 WHERE id=$1', [a.id, String(msg.chat?.id ?? channelChat), msg.message_id]);
    return { ok: true };
  } catch (e) {
    console.error('channel post failed', a.id, e.message);
    const hint = chatErrHint(e.message);
    if (warn) notifyAdmins(`⚠️ Не удалось опубликовать лот №${a.id} в канале: ${h(e.message)}\n${h(hint)}\nПовторить: /post ${a.id}`);
    return { ok: false, error: hint || e.message };
  }
}

// репост: старый пост удаляем (если есть) и публикуем заново
async function repostLot(a) {
  const oldMsg = a.channel_msg_id, oldChat = a.channel_chat;
  const r = await postLotToChannel(a, { warn: false });
  if (r.ok && oldMsg && oldChat) {
    const chat = /^-?\d+$/.test(oldChat) ? Number(oldChat) : oldChat;
    await bot?.api.deleteMessage(chat, oldMsg).catch(() => {});
  }
  return r;
}

async function saveChannel(chat) {
  channelChat = chat.id;
  await q(`INSERT INTO meta(key,value) VALUES ('channel_id',$1) ON CONFLICT (key) DO UPDATE SET value=$1`, [String(chat.id)]);
  subCache.clear();
}

// обновляем пост в канале, когда лот закончился или снят
async function updateChannelPost(a, statusLine) {
  if (!bot || !a.channel_msg_id || !a.channel_chat) return;
  const chat = /^-?\d+$/.test(a.channel_chat) ? Number(a.channel_chat) : a.channel_chat;
  try {
    const kb = new InlineKeyboard();
    if (botLink()) kb.url('Смотреть другие лоты', botLink());
    const caption = `🔨 <b>${h(a.title)}</b>\n\n📏 Размер: ${h(a.size)}\n📍 Встреча: ${h(a.city)}\n\n${statusLine}`;
    await bot.api.editMessageCaption(chat, a.channel_msg_id, { caption, parse_mode: 'HTML', ...(botLink() ? { reply_markup: kb } : {}) });
  } catch (e) {
    console.error('channel edit failed', a.id, e.message);
  }
}

// ---------- жизненный цикл лота ----------
async function activate(id, method) {
  const { rows } = await q(
    `UPDATE auctions
       SET status='active', pay_method=$2, started_at=now(), bumped_at=now(),
           ends_at = now() + make_interval(hours => duration_hours)
     WHERE id=$1 AND status='draft'
     RETURNING *`,
    [id, method]
  );
  const a = rows[0];
  if (a) {
    const link = lotLink(a.id);
    notify(a.seller_id, `✅ Лот №${a.id} «${h(a.title)}» опубликован.\nТорги идут до ${fmtDate(a.ends_at)}.${channelChat && POST_TO_CHANNEL ? '\nПост с лотом отправлен в канал.' : ''}${link ? `\n\nСсылка на лот: ${link}` : ''}`, lotKb(a.id));
    postLotToChannel(a);
  }
  return a;
}

async function finishAuctions() {
  const { rows } = await q(`UPDATE auctions SET status='ended' WHERE status='active' AND ends_at <= now() RETURNING *`);
  for (const a of rows) {
    if (a.bids_count > 0 && a.leader_id) {
      await notify(
        a.seller_id,
        `🏁 Лот №${a.id} «${h(a.title)}» завершён.\nПобедитель: ${userLink(a.leader_id, a.leader_name)}\nИтоговая цена: ${fmt(a.current_price)} BYN\nСвяжитесь для личной встречи (${h(a.city)}).`
      );
      await notify(
        a.leader_id,
        `🏆 Вы выиграли лот №${a.id} «${h(a.title)}» за ${fmt(a.current_price)} BYN!\nЛичная встреча: ${h(a.city)}\nКонтакт владельца: ${h(a.contact)}`
      );
      await updateChannelPost(a, `🏁 <b>Торги завершены</b>\nИтоговая цена: ${fmt(a.current_price)} BYN · ставок: ${a.bids_count}`);
    } else {
      await notify(a.seller_id, `Лот №${a.id} «${h(a.title)}» завершён без ставок. Можно выставить его снова с меньшей ценой.`);
      await updateChannelPost(a, '🏁 <b>Торги завершены</b>\nСтавок не было');
    }
  }
}

// пост «скоро конец» в канал и рассылка всем подписчикам бота
async function announceEnding(a, alreadyNotified) {
  const left = leftHuman(new Date(a.ends_at) - Date.now());
  const link = lotLink(a.id);
  const text = `🔥 <b>Аукцион скоро закончится!</b>\n\n🔨 <b>${h(a.title)}</b>\n📏 ${h(a.size)} · 📍 ${h(a.city)}\n\n💵 Сейчас: <b>${fmt(a.current_price)} BYN</b>${a.bids_count ? ` · ставок: ${a.bids_count}` : ' · ставок пока нет'}\n⏳ Осталось: ~${left}\n\n⚡ Ещё можно перебить цену — успейте!`;
  const kb = new InlineKeyboard();
  if (link) kb.url('🔨 Перебить ставку', link);
  const markup = link ? { reply_markup: kb } : {};
  if (bot && channelChat && POST_TO_CHANNEL) {
    try {
      const reply = a.channel_msg_id && String(a.channel_chat) === String(channelChat)
        ? { reply_parameters: { message_id: a.channel_msg_id, allow_sending_without_reply: true } } : {};
      const photo = await lotPhoto(a);
      if (photo) await bot.api.sendPhoto(channelChat, photo, { caption: text, parse_mode: 'HTML', ...markup, ...reply });
      else await bot.api.sendMessage(channelChat, text, { parse_mode: 'HTML', ...markup, ...reply });
    } catch (e) { console.error('ending channel post', a.id, e.message); }
  }
  const { rows } = await q('SELECT user_id FROM users WHERE notify AND NOT blocked AND user_id <> $1', [a.seller_id]);
  for (const r of rows) {
    const uid = Number(r.user_id);
    if (alreadyNotified.has(uid)) continue;
    await notify(uid, text, markup);
    await sleep(50);
  }
}

// напоминания участникам: за час и за 15 минут до конца
async function remindEnding() {
  if (!bot) return;
  for (const [col, interval, label] of [['notified_1h', '1 hour', 'час'], ['notified_15m', '15 minutes', '15 минут']]) {
    const { rows } = await q(
      `UPDATE auctions SET ${col}=true
       WHERE status='active' AND NOT ${col} AND ends_at > now() AND ends_at <= now() + interval '${interval}'
       RETURNING *`
    );
    for (const a of rows) {
      const { rows: people } = await q(
        `SELECT p.user_id, p.is_bidder FROM (
           SELECT user_id, true AS is_bidder FROM bids WHERE auction_id=$1
           UNION
           SELECT user_id, false FROM auction_favorites WHERE auction_id=$1
         ) p LEFT JOIN users u ON u.user_id = p.user_id
         WHERE COALESCE(u.notify, true) AND NOT COALESCE(u.blocked, false) AND p.user_id <> $2`,
        [a.id, a.seller_id]
      );
      const bidders = new Set(people.filter((p) => p.is_bidder).map((p) => Number(p.user_id)));
      const ids = [...new Set(people.map((p) => Number(p.user_id)))];
      for (const uid of ids) {
        let tail = '';
        if (Number(a.leader_id) === uid) tail = '\nСейчас вы лидируете 🎉 Но вас могут перебить.';
        else if (bidders.has(uid)) tail = '\nВас перебили — успейте ответить!';
        await notify(uid, `⏰ Через ${label} закончится аукцион «${h(a.title)}»\nСейчас: ${fmt(a.current_price)} BYN${a.bids_count ? ` · ставок: ${a.bids_count}` : ''}${tail}`, lotKb(a.id, '🔨 К лоту'));
        await sleep(50);
      }
      if (col === 'notified_1h') {
        await announceEnding(a, new Set(ids)).catch((e) => console.error('announceEnding', e.message));
        await notify(a.seller_id, `⏰ Ваш лот «${h(a.title)}» закончится через час. Сейчас ${fmt(a.current_price)} BYN, ставок: ${a.bids_count}.`, lotKb(a.id));
      }
    }
  }
}

// ежедневный дайджест «скоро закончатся»
async function maybeSendDigest() {
  if (!bot) return;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' })
      .formatToParts(new Date()).map((p) => [p.type, p.value])
  );
  if (Number(parts.hour) !== DIGEST_HOUR) return;
  const ins = await q(`INSERT INTO meta(key) VALUES ($1) ON CONFLICT DO NOTHING RETURNING key`, [`digest:${parts.year}-${parts.month}-${parts.day}`]);
  if (!ins.rowCount) return; // сегодня уже отправляли
  const { rows } = await q(
    `SELECT * FROM auctions WHERE status='active' AND ends_at > now() AND ends_at <= now() + interval '24 hours' ORDER BY ends_at LIMIT 6`
  );
  if (!rows.length) return;
  const lines = rows.map((a, i) => {
    const link = lotLink(a.id);
    const title = link ? `<a href="${link}">${h(a.title)}</a>` : h(a.title);
    return `${i + 1}. ${title} — ${fmt(a.current_price)} BYN · через ${leftHuman(new Date(a.ends_at) - Date.now())}`;
  });
  const text = `🔥 <b>Скоро закончатся торги</b>\n\n${lines.join('\n')}\n\nУспейте сделать ставку 👇`;
  const { rows: subs } = await q('SELECT user_id FROM users WHERE notify AND NOT blocked');
  let sent = 0;
  for (const s of subs) {
    if (await notify(s.user_id, text, openAppKb())) sent++;
    await sleep(50);
  }
  console.log(`digest sent to ${sent}/${subs.length}`);
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, file) => {
    if (file.endsWith('.js')) res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    else if (file.endsWith('.css')) res.setHeader('Content-Type', 'text/css; charset=utf-8');
    else if (file.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
  },
}));

app.get('/health', (_req, res) => res.send('ok'));

// avatar from the Telegram channel
let avatarCache = { at: 0, buf: null };
app.get('/avatar.jpg', wrap(async (_req, res) => {
  if (!CHANNEL || !BOT_TOKEN || !bot) return res.status(404).end();
  if (!avatarCache.buf || Date.now() - avatarCache.at > 6 * 3600 * 1000) {
    try {
      const chat = await bot.api.getChat('@' + CHANNEL);
      if (!chat.photo) return res.status(404).end();
      const file = await bot.api.getFile(chat.photo.big_file_id);
      const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`);
      avatarCache = { at: Date.now(), buf: Buffer.from(await r.arrayBuffer()) };
    } catch (e) {
      console.error('avatar', e.message);
      if (!avatarCache.buf) return res.status(404).end();
    }
  }
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(avatarCache.buf);
}));

app.get('/img/:id', wrap(async (req, res) => {
  const { rows } = await q('SELECT mime, data FROM images WHERE id=$1', [Number(req.params.id)]);
  if (!rows.length) return res.status(404).end();
  res.set('Content-Type', rows[0].mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(rows[0].data);
}));

// photo upload — any signed-in user (needed to list a lot)
app.post('/api/upload', auth, express.raw({ type: 'image/*', limit: '6mb' }), wrap(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new HttpError(400, 'Файл не получен');
  const mime = req.get('Content-Type').split(';')[0];
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new HttpError(400, 'Допустимы JPG, PNG, WEBP');
  const { rows: cnt } = await q(`SELECT count(*)::int AS n FROM images WHERE owner=$1 AND created_at > now() - interval '1 day'`, [req.user.id]);
  if (cnt[0].n >= 60) throw new HttpError(429, 'Слишком много загрузок за сутки');
  const { rows } = await q('INSERT INTO images(mime, data, owner) VALUES ($1,$2,$3) RETURNING id', [mime, req.body, req.user.id]);
  res.json({ id: rows[0].id });
}));

app.use('/api', express.json({ limit: '1mb' }));

app.get('/api/config', (_req, res) => res.json({
  shopName: SHOP_NAME,
  channel: CHANNEL || null,
  avatar: process.env.AVATAR_FROM_CHANNEL === 'true' && !!CHANNEL, // по умолчанию в шапке логотип LOT24
  maxStep: MAX_STEP,
  durations: DURATIONS,
  bumpStars: BUMP_STARS,
  antiSnipeMin: ANTI_SNIPE_MIN,
}));

app.get('/api/me', auth, wrap(async (req, res) => {
  touchUser(req.user).catch((e) => console.error('touchUser', e.message));
  res.json({
    id: req.user.id,
    name: [req.user.first_name, req.user.last_name].filter(Boolean).join(' '),
    username: req.user.username || null,
    isAdmin: req.isAdmin,
    subscribed: await isSubscribed(req.user.id),
  });
}));

// ---------- auctions: read ----------
const mapAuction = (a, userId, isAdmin = false) => ({
  id: a.id,
  title: a.title,
  description: a.description,
  size: a.size,
  city: a.city,
  contact: a.status === 'active' || Number(a.seller_id) === Number(userId) || (a.leader_id != null && Number(a.leader_id) === Number(userId)) || isAdmin ? a.contact : '',
  image_ids: a.image_ids,
  images: a.image_ids.map((i) => `/img/${i}`),
  start_price: a.start_price,
  min_step: a.min_step,
  max_step: a.max_step,
  current_price: a.current_price,
  bids_count: a.bids_count,
  leader_name: a.leader_name,
  status: a.status,
  duration_hours: a.duration_hours,
  stars: priceOf(a.duration_hours),
  ends_at: a.ends_at,
  started_at: a.started_at,
  created_at: a.created_at,
  link: lotLink(a.id),
  mine: Number(a.seller_id) === Number(userId),
  leading: a.leader_id != null && Number(a.leader_id) === Number(userId),
  fav: !!a.fav,
});

const SORTS = {
  bump: 'a.bumped_at DESC',
  ending: 'a.ends_at ASC',
  new: 'a.id DESC',
  price_asc: 'a.current_price ASC',
  price_desc: 'a.current_price DESC',
};

app.get('/api/auctions', auth, wrap(async (req, res) => {
  const scope = String(req.query.scope || 'all');
  const search = clean(req.query.q, 100);
  const params = [req.user.id];
  const where = [];
  if (scope === 'mine') where.push(`a.seller_id=$1 AND a.status <> 'cancelled'`);
  else if (scope === 'fav') where.push(`a.status IN ('active','ended') AND EXISTS(SELECT 1 FROM auction_favorites f WHERE f.user_id=$1 AND f.auction_id=a.id)`);
  else if (scope === 'bidding') where.push(`a.status IN ('active','ended') AND EXISTS(SELECT 1 FROM bids b WHERE b.user_id=$1 AND b.auction_id=a.id)`);
  else where.push(`a.status='active' AND a.ends_at > now()`);
  if (search) { params.push(search); where.push(`a.title ILIKE '%' || $${params.length} || '%'`); }
  const defaultSort = scope === 'all' ? 'bump' : 'new';
  const order = SORTS[req.query.sort] || SORTS[defaultSort];
  const { rows } = await q(
    `SELECT a.*, EXISTS(SELECT 1 FROM auction_favorites f WHERE f.user_id=$1 AND f.auction_id=a.id) AS fav
     FROM auctions a WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 200`,
    params
  );
  res.json({ now: new Date().toISOString(), items: rows.map((a) => mapAuction(a, req.user.id)) });
}));

app.get('/api/auctions/:id', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows } = await q(
    `SELECT a.*, EXISTS(SELECT 1 FROM auction_favorites f WHERE f.user_id=$2 AND f.auction_id=a.id) AS fav
     FROM auctions a WHERE a.id=$1`,
    [id, req.user.id]
  );
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Лот не найден');
  const mine = Number(a.seller_id) === Number(req.user.id);
  if (!['active', 'ended'].includes(a.status) && !mine && !req.isAdmin) throw new HttpError(404, 'Лот не найден');
  const { rows: bids } = await q('SELECT user_name, amount, created_at FROM bids WHERE auction_id=$1 ORDER BY id DESC LIMIT 20', [id]);
  res.json({ now: new Date().toISOString(), item: mapAuction(a, req.user.id, req.isAdmin), bids });
}));

// ---------- favorites ----------
app.post('/api/favorites/:id', auth, wrap(async (req, res) => {
  const { rowCount } = await q('SELECT 1 FROM auctions WHERE id=$1', [Number(req.params.id)]);
  if (!rowCount) throw new HttpError(404, 'Лот не найден');
  await q('INSERT INTO auction_favorites(user_id, auction_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, Number(req.params.id)]);
  res.json({ ok: true });
}));
app.delete('/api/favorites/:id', auth, wrap(async (req, res) => {
  await q('DELETE FROM auction_favorites WHERE user_id=$1 AND auction_id=$2', [req.user.id, Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- auctions: create & pay ----------
app.post('/api/auctions', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const title = clean(b.title, 100);
  const size = clean(b.size, 30);
  const city = clean(b.city, 60);
  const contact = clean(b.contact, 80);
  const description = clean(b.description, 3000);
  const startPrice = num(b.start_price);
  const minStep = num(b.min_step);
  const duration = DURATIONS.find((d) => d.hours === Number(b.duration_hours)) || DURATIONS[0];

  if (!title) throw new HttpError(400, 'Укажите название');
  if (!size) throw new HttpError(400, 'Укажите размер');
  if (!city) throw new HttpError(400, 'Укажите город для личной встречи');
  if (!contact) throw new HttpError(400, 'Укажите контакт для связи');
  if (!(startPrice > 0) || startPrice > 100000) throw new HttpError(400, 'Укажите стартовую цену');
  if (!(minStep > 0)) throw new HttpError(400, 'Минимальный шаг должен быть больше 0');
  if (minStep > MAX_STEP) throw new HttpError(400, `Минимальный шаг не может быть больше ${MAX_STEP} BYN`);

  const wanted = Array.isArray(b.image_ids) ? b.image_ids.map(Number).filter(Number.isInteger).slice(0, 10) : [];
  const { rows: imgs } = await q('SELECT id FROM images WHERE id = ANY($1::int[]) AND owner=$2', [wanted, req.user.id]);
  const owned = new Set(imgs.map((r) => r.id));
  const image_ids = wanted.filter((i) => owned.has(i));
  if (!image_ids.length) throw new HttpError(400, 'Добавьте хотя бы одно фото');

  const { rows: cnt } = await q(`SELECT count(*)::int AS n FROM auctions WHERE seller_id=$1 AND status='draft'`, [req.user.id]);
  if (cnt[0].n >= 10) throw new HttpError(400, 'Слишком много неоплаченных лотов. Оплатите или удалите старые.');

  const { rows } = await q(
    `INSERT INTO auctions(seller_id, seller_name, title, description, size, city, contact, image_ids, start_price, min_step, max_step, current_price, duration_hours)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$9,$12) RETURNING id`,
    [req.user.id, req.displayName, title, description, size, city, contact, image_ids, startPrice, minStep, MAX_STEP, duration.hours]
  );
  const id = rows[0].id;
  if (duration.stars === 0) {
    await activate(id, 'free');
    await q(`INSERT INTO payments(user_id, kind, auction_id, method, amount) VALUES ($1,'list',$2,'free',0)`, [req.user.id, id]);
    return res.json({ id, published: true });
  }
  res.json({ id, published: false, stars: duration.stars, hours: duration.hours });
}));

async function getOwnLot(req, statuses) {
  const { rows } = await q('SELECT * FROM auctions WHERE id=$1', [Number(req.params.id)]);
  const a = rows[0];
  if (!a || Number(a.seller_id) !== Number(req.user.id)) throw new HttpError(404, 'Лот не найден');
  if (!statuses.includes(a.status)) throw new HttpError(400, 'Это действие сейчас недоступно');
  return a;
}

async function makeInvoice(title, description, payload, label, amount) {
  if (!bot) throw new HttpError(503, 'Бот не настроен');
  return bot.api.createInvoiceLink(title.slice(0, 32), description.slice(0, 250), payload, '', 'XTR', [{ label, amount }]);
}

app.post('/api/auctions/:id/pay/stars', auth, wrap(async (req, res) => {
  const a = await getOwnLot(req, ['draft']);
  const stars = priceOf(a.duration_hours);
  if (stars <= 0) {
    await activate(a.id, 'free');
    return res.json({ published: true });
  }
  const link = await makeInvoice(`Размещение лота №${a.id}`, `Аукцион на ${a.duration_hours} ч: ${a.title}`, `list:${a.id}:${req.user.id}`, `Торги ${a.duration_hours} ч`, stars);
  res.json({ link });
}));

app.post('/api/auctions/:id/publish-free', auth, adminOnly, wrap(async (req, res) => {
  const a = await getOwnLot(req, ['draft']);
  await activate(a.id, 'admin');
  await q(`INSERT INTO payments(user_id, kind, auction_id, method, amount) VALUES ($1,'list',$2,'admin',0)`, [req.user.id, a.id]);
  res.json({ ok: true });
}));

app.post('/api/auctions/:id/bump', auth, wrap(async (req, res) => {
  const a = await getOwnLot(req, ['active']);
  if (new Date(a.ends_at) <= new Date()) throw new HttpError(400, 'Аукцион уже завершён');
  const link = await makeInvoice(`Поднятие лота №${a.id}`, `Поднять в начало списка: ${a.title}`, `bump:${a.id}:${req.user.id}`, 'Поднятие лота', BUMP_STARS);
  res.json({ link });
}));

app.delete('/api/auctions/:id', auth, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM auctions WHERE id=$1', [Number(req.params.id)]);
  const a = rows[0];
  if (!a || a.status === 'cancelled') throw new HttpError(404, 'Лот не найден');
  const mine = Number(a.seller_id) === Number(req.user.id);
  if (!mine && !req.isAdmin) throw new HttpError(403, 'Нет доступа');
  if (!req.isAdmin) {
    const canCancel = a.status === 'draft' || (a.status === 'active' && a.bids_count === 0);
    if (!canCancel) throw new HttpError(400, 'Лот со ставками отменить нельзя');
  }
  await q(`UPDATE auctions SET status='cancelled' WHERE id=$1`, [a.id]);
  await updateChannelPost(a, '🚫 <b>Лот снят с торгов</b>');
  if (!mine) notify(a.seller_id, `Лот №${a.id} «${h(a.title)}» снят администратором.`);
  res.json({ ok: true });
}));

// ---------- bids ----------
app.post('/api/auctions/:id/bid', auth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const amount = num(req.body?.amount);
  if (!(amount > 0)) throw new HttpError(400, 'Введите сумму ставки');

  const client = await pool.connect();
  let a;
  let prevLeader = null;
  let extendedTo = null;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT *, (ends_at > now()) AS live FROM auctions WHERE id=$1 FOR UPDATE', [id]);
    a = rows[0];
    if (!a || a.status !== 'active') throw new HttpError(404, 'Лот недоступен');
    if (!a.live) throw new HttpError(400, 'Аукцион завершён');
    if (Number(a.seller_id) === Number(req.user.id)) throw new HttpError(400, 'Нельзя делать ставки на свой лот');
    if (a.leader_id != null && Number(a.leader_id) === Number(req.user.id)) throw new HttpError(400, 'Ваша ставка уже лидирует');

    const first = a.bids_count === 0;
    const lo = first ? cents(a.start_price) : cents(a.current_price) + cents(a.min_step);
    const hi = (first ? cents(a.start_price) : cents(a.current_price)) + cents(a.max_step);
    const c = cents(amount);
    if (c < lo || c > hi) {
      throw new HttpError(400, `Ставка должна быть от ${fmt(lo / 100)} до ${fmt(hi / 100)} BYN`);
    }

    await client.query('INSERT INTO bids(auction_id, user_id, user_name, amount) VALUES ($1,$2,$3,$4)', [id, req.user.id, req.displayName, amount]);
    prevLeader = a.leader_id;
    await client.query(
      'UPDATE auctions SET current_price=$2, bids_count=bids_count+1, leader_id=$3, leader_name=$4 WHERE id=$1',
      [id, amount, req.user.id, req.displayName]
    );
    // антиснайпер: ставка в последние минуты продлевает торги
    if (ANTI_SNIPE_MIN > 0 && a.extensions < ANTI_SNIPE_MAX_EXT) {
      const r = await client.query(
        `UPDATE auctions SET ends_at = now() + make_interval(mins => $2), extensions = extensions + 1
         WHERE id=$1 AND ends_at < now() + make_interval(mins => $2) RETURNING ends_at`,
        [id, ANTI_SNIPE_MIN]
      );
      if (r.rowCount) extendedTo = r.rows[0].ends_at;
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  const ext = extendedTo ? `\nТорги продлены до ${fmtDate(extendedTo)}.` : '';
  if (prevLeader) notify(prevLeader, `⚡ Вашу ставку перебили на лоте «${h(a.title)}». Сейчас ${fmt(amount)} BYN.${ext}`, lotKb(id, '🔨 Ответить ставкой'));
  notify(a.seller_id, `💰 Новая ставка на лот «${h(a.title)}»: ${fmt(amount)} BYN (${h(req.displayName)})${ext}`);
  res.json({ ok: true, current_price: amount, extended: !!extendedTo });
}));

// ---------- admin ----------
app.get('/api/admin/auctions', auth, adminOnly, wrap(async (req, res) => {
  const status = req.query.status;
  const { rows } = await q(
    `SELECT a.* FROM auctions a WHERE ($1::text IS NULL OR a.status=$1) AND a.status <> 'draft' ORDER BY a.id DESC LIMIT 100`,
    [status || null]
  );
  res.json({ now: new Date().toISOString(), items: rows.map((a) => ({ ...mapAuction(a, req.user.id, true), seller_id: a.seller_id, seller_name: a.seller_name })) });
}));

app.post('/api/admin/auctions/:id/repost', auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await q('SELECT * FROM auctions WHERE id=$1', [Number(req.params.id)]);
  const a = rows[0];
  if (!a) throw new HttpError(404, 'Лот не найден');
  if (a.status !== 'active') throw new HttpError(400, 'В канал можно отправить только активный лот');
  const r = await repostLot(a);
  res.json(r.ok ? { ok: true } : { ok: false, error: r.error || 'Не удалось отправить в канал' });
}));

// ---------- bot setup ----------
async function startBot() {
  if (!BOT_TOKEN) { console.warn('BOT_TOKEN not set, bot disabled (DEV mode)'); return; }
  bot = new Bot(BOT_TOKEN);
  await bot.init();
  botUsername = bot.botInfo.username;
  if (!process.env.CHANNEL_ID) {
    const { rows } = await q(`SELECT value FROM meta WHERE key='channel_id'`);
    if (rows[0]) channelChat = Number(rows[0].value);
  }
  console.log(`Bot @${botUsername} ready`);

  const durationsText = () => DURATIONS.map((d) => `${d.hours === 24 ? '24 часа' : d.hours / 24 + ' дня'} — ${d.stars ? d.stars + ' ⭐' : 'бесплатно'}`).join(' · ');

  const welcomeText = () =>
    `<b>Добро пожаловать в ${h(SHOP_NAME)}!</b> 👋\n\n` +
    `Аукцион вещей прямо в Telegram.\n\n` +
    `🔨 Выставляйте свои вещи на торги\n` +
    `⏱ Срок: ${durationsText()}\n` +
    `💸 Делайте ставки и выигрывайте лоты\n` +
    `🔔 Бот напомнит, когда торги закончатся\n` +
    `🤝 Победитель и продавец договариваются о личной встрече\n\n` +
    `Нажмите кнопку ниже, чтобы открыть аукцион 👇`;

  const helpText = () =>
    `<b>Как это работает</b>\n\n` +
    `<b>Выставить лот</b>\nВкладка «Выставить»: фото, название, размер, стартовая цена, шаг ставки, город для встречи и ваш контакт.\nСрок торгов: ${durationsText()}.\nНовый лот автоматически появляется в нашем канале со ссылкой.\n\n` +
    `<b>Сделать ставку</b>\nОткройте лот и выберите сумму. Шаг ставки — от минимального шага лота до ${fmt(MAX_STEP)} BYN.${ANTI_SNIPE_MIN ? ` Если ставку сделали в последние ${ANTI_SNIPE_MIN} мин, торги продлеваются.` : ''}\n\n` +
    `<b>Уведомления</b>\nБот пишет, если вашу ставку перебили, за час и за 15 минут до конца лотов из «Избранного» и ваших ставок, а также присылает ежедневный дайджест «Скоро закончатся».\n/mute — отключить напоминания и дайджест, /unmute — включить.\n\n` +
    `<b>Итоги</b>\nПобедитель получит контакт владельца и город, продавец — профиль победителя.\n\n` +
    `<b>Поднять лот</b>\nЗа ${BUMP_STARS} ⭐ лот окажется в начале списка.\n\n` +
    `<b>Безопасность</b>\nВстречайтесь в людных местах, осматривайте вещь перед оплатой и не переводите предоплату незнакомым людям.`;

  const startKb = () => {
    const kb = new InlineKeyboard();
    if (WEBAPP_URL) kb.webApp('🔨 Открыть аукцион', WEBAPP_URL).row();
    kb.text('ℹ️ Как это работает', 'how');
    if (CHANNEL) kb.row().url('📣 Наш канал', `https://t.me/${CHANNEL}`);
    return kb;
  };

  async function sendLotCard(ctx, id) {
    const { rows } = await q('SELECT * FROM auctions WHERE id=$1', [id]);
    const a = rows[0];
    if (!a || !['active', 'ended'].includes(a.status)) return ctx.reply('Лот не найден или снят с торгов.', openAppKb());
    const live = a.status === 'active' && new Date(a.ends_at) > new Date();
    const extra = live
      ? `💵 Сейчас: <b>${fmt(a.current_price)} BYN</b> · ставок: ${a.bids_count}\n⏳ Осталось: ${leftHuman(new Date(a.ends_at) - Date.now())}`
      : `🏁 Торги завершены. Итог: ${fmt(a.current_price)} BYN`;
    const caption = lotCaption(a, extra);
    const opts = { caption, parse_mode: 'HTML', ...lotKb(a.id, live ? '🔨 Сделать ставку' : 'Открыть лот') };
    const photo = await lotPhoto(a);
    if (photo) return ctx.replyWithPhoto(photo, opts);
    return ctx.reply(caption, { parse_mode: 'HTML', ...lotKb(a.id, live ? '🔨 Сделать ставку' : 'Открыть лот') });
  }

  let welcomePhotoId = null; // кэшируем file_id, чтобы не загружать картинку каждый раз
  const subKb = (payload) => {
    const kb = new InlineKeyboard();
    if (CHANNEL) kb.url('📣 Подписаться на канал', `https://t.me/${CHANNEL}`).row();
    return kb.text('✅ Я подписался(ась)', 'checksub:' + (payload || ''));
  };
  const subText = () => `🔒 Чтобы пользоваться ${h(SHOP_NAME)}, подпишитесь на наш канал: там публикуются все лоты.\n\nПосле подписки нажмите «Я подписался(ась)».`;

  async function showStart(ctx, payload) {
    const m = /^lot_(\d+)$/.exec(String(payload || '').trim());
    if (m) {
      try { return await sendLotCard(ctx, Number(m[1])); } catch (e) { console.error('lot card', e.message); }
    }
    const opts = { caption: welcomeText(), parse_mode: 'HTML', reply_markup: startKb() };
    try {
      if (welcomePhotoId) return await ctx.replyWithPhoto(welcomePhotoId, opts);
      const msg = await ctx.replyWithPhoto(new InputFile(path.join(__dirname, 'public', 'welcome.jpg')), opts);
      welcomePhotoId = msg.photo?.[msg.photo.length - 1]?.file_id || null;
    } catch (e) {
      console.error('welcome photo', e.message);
      await ctx.reply(welcomeText(), { parse_mode: 'HTML', reply_markup: startKb() });
    }
  }

  bot.callbackQuery(/^checksub:(.*)$/, async (ctx) => {
    subCache.delete(ctx.from.id);
    if (!(await isSubscribed(ctx.from.id))) return ctx.answerCallbackQuery({ text: 'Подписка не найдена. Подпишитесь на канал и нажмите ещё раз.', show_alert: true });
    await ctx.answerCallbackQuery({ text: 'Спасибо! Добро пожаловать' });
    await ctx.deleteMessage().catch(() => {});
    await showStart(ctx, ctx.match[1]);
  });

  bot.command('start', async (ctx) => {
    touchUser(ctx.from, true).catch(() => {});
    const payload = String(ctx.match || '').trim();
    if (!(await isSubscribed(ctx.from.id))) return ctx.reply(subText(), { parse_mode: 'HTML', reply_markup: subKb(payload) });
    return showStart(ctx, payload);
  });

  bot.command('help', (ctx) => ctx.reply(helpText(), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } }));
  bot.callbackQuery('how', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.reply(helpText(), { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  });

  bot.command('mute', async (ctx) => {
    await touchUser(ctx.from, true);
    await q('UPDATE users SET notify=false WHERE user_id=$1', [ctx.from.id]);
    await ctx.reply('🔕 Напоминания и дайджест отключены. Уведомления о перебитых ставках и итогах торгов продолжат приходить. Включить обратно: /unmute');
  });
  bot.command('unmute', async (ctx) => {
    await touchUser(ctx.from, true);
    await q('UPDATE users SET notify=true WHERE user_id=$1', [ctx.from.id]);
    await ctx.reply('🔔 Напоминания и дайджест включены.');
  });

  // ----- команды администратора -----
  const adminOnlyCmd = (fn) => async (ctx) => {
    if (!ADMIN_IDS.includes(ctx.from?.id)) return;
    try { await fn(ctx); } catch (e) { console.error('admin cmd', e.message); await ctx.reply('Ошибка: ' + e.message); }
  };

  bot.command('stats', adminOnlyCmd(async (ctx) => {
    const { rows } = await q(`SELECT
      (SELECT count(*) FROM users) AS users,
      (SELECT count(*) FROM users WHERE blocked) AS blocked,
      (SELECT count(*) FROM auctions WHERE status='active' AND ends_at > now()) AS active,
      (SELECT count(*) FROM auctions WHERE status='ended') AS ended,
      (SELECT count(*) FROM auctions WHERE status='draft') AS drafts,
      (SELECT count(*) FROM bids) AS bids,
      (SELECT coalesce(sum(amount),0) FROM payments WHERE method='stars') AS stars`);
    const s = rows[0];
    await ctx.reply(
      `📊 <b>Статистика</b>\nПользователей: ${s.users} (заблокировали бота: ${s.blocked})\nАктивных лотов: ${s.active}\nЗавершённых: ${s.ended}\nНеоплаченных черновиков: ${s.drafts}\nВсего ставок: ${s.bids}\nПолучено звёзд: ${fmt(s.stars)} ⭐`,
      { parse_mode: 'HTML' }
    );
  }));

  bot.command('backup', adminOnlyCmd(async (ctx) => {
    const [auctions, bids, users, payments] = await Promise.all([
      q('SELECT * FROM auctions ORDER BY id'), q('SELECT * FROM bids ORDER BY id'),
      q('SELECT * FROM users ORDER BY user_id'), q('SELECT * FROM payments ORDER BY id'),
    ]);
    const json = JSON.stringify({ exported_at: new Date().toISOString(), auctions: auctions.rows, bids: bids.rows, users: users.rows, payments: payments.rows }, null, 1);
    const day = new Date().toISOString().slice(0, 10);
    await ctx.replyWithDocument(new InputFile(Buffer.from(json, 'utf-8'), `lot24-backup-${day}.json`), {
      caption: `Резервная копия: лотов ${auctions.rowCount}, ставок ${bids.rowCount}, пользователей ${users.rowCount}. Фото хранятся в базе данных (бэкапьте её средствами Railway).`,
    });
  }));

  bot.command('broadcast', adminOnlyCmd(async (ctx) => {
    const text = String(ctx.match || '').trim();
    if (!text) return ctx.reply('Использование: /broadcast текст сообщения (HTML-теги <b>, <i>, <a> допустимы)');
    const { rows } = await q('SELECT user_id FROM users WHERE NOT blocked');
    await ctx.reply(`Отправляю ${rows.length} пользователям…`);
    let ok = 0;
    for (const r of rows) {
      if (await notify(r.user_id, text, openAppKb())) ok++;
      await sleep(50);
    }
    await ctx.reply(`Готово: доставлено ${ok} из ${rows.length}.`);
  }));

  bot.command('setchannel', adminOnlyCmd(async (ctx) => {
    const arg = String(ctx.match || '').trim().replace(/^https?:\/\/t\.me\//, '');
    if (!arg) return ctx.reply('Использование: /setchannel @username_канала (или -100… id). Бот должен быть админом канала.');
    const target = /^-?\d+$/.test(arg) ? Number(arg) : '@' + arg.replace(/^@/, '');
    let chat;
    try { chat = await bot.api.getChat(target); } catch (e) { return ctx.reply(`Канал не найден (${e.message}). Для приватного канала используйте числовой id -100…`); }
    if (chat.type !== 'channel') return ctx.reply('Это не канал.');
    let status = '?';
    try { status = (await bot.api.getChatMember(chat.id, bot.botInfo.id)).status; } catch {}
    await saveChannel(chat);
    await ctx.reply(`✅ Канал «${chat.title}» сохранён (id ${chat.id}). Статус бота: ${status}${status === 'administrator' ? '' : '\n⚠️ Сделайте бота администратором с правом публикации.'}`);
  }));

  // бот добавили/сделали админом в канале — запоминаем канал автоматически
  bot.on('my_chat_member', async (ctx) => {
    const c = ctx.chat;
    if (c.type !== 'channel') return;
    const st = ctx.myChatMember.new_chat_member.status;
    if (st !== 'administrator') return;
    if (channelChat && String(channelChat) !== String(c.id) && !(CHANNEL && c.username?.toLowerCase() === CHANNEL.toLowerCase())) return;
    await saveChannel(c);
    notifyAdmins(`✅ Бот стал администратором канала «${h(c.title)}». Лоты будут публиковаться сюда.`);
  });
  bot.on('channel_post', async (ctx) => {
    const c = ctx.chat;
    if (CHANNEL && c.username?.toLowerCase() === CHANNEL.toLowerCase() && String(channelChat) !== String(c.id)) await saveChannel(c);
  });

  bot.command('post', adminOnlyCmd(async (ctx) => {
    const id = Number(String(ctx.match || '').trim());
    if (!id) return ctx.reply('Использование: /post НОМЕР_ЛОТА — повторно отправить лот в канал');
    const { rows } = await q(`SELECT * FROM auctions WHERE id=$1 AND status='active'`, [id]);
    if (!rows[0]) return ctx.reply('Активный лот не найден.');
    const r = await repostLot(rows[0]);
    await ctx.reply(r.ok ? '✅ Лот отправлен в канал.' : '❌ ' + r.error);
  }));

  // описание бота (видно до нажатия START) и меню команд
  bot.api.setMyDescription(`${SHOP_NAME} — аукцион вещей в Telegram. Выставляйте лоты, делайте ставки, бот напомнит о конце торгов. Нажмите START!`).catch((e) => console.error('description', e.message));
  bot.api.setMyShortDescription('Аукцион вещей: выставляйте лоты и делайте ставки. Торги 24 часа и дольше 🔨').catch((e) => console.error('short description', e.message));
  bot.api.setMyCommands([
    { command: 'start', description: 'Открыть аукцион' },
    { command: 'help', description: 'Как это работает' },
    { command: 'mute', description: 'Отключить напоминания' },
    { command: 'unmute', description: 'Включить напоминания' },
  ]).catch((e) => console.error('commands', e.message));
  for (const id of ADMIN_IDS) {
    bot.api.setMyCommands([
      { command: 'start', description: 'Открыть аукцион' },
      { command: 'help', description: 'Как это работает' },
      { command: 'mute', description: 'Отключить напоминания' },
      { command: 'unmute', description: 'Включить напоминания' },
      { command: 'stats', description: 'Статистика (админ)' },
      { command: 'backup', description: 'Резервная копия (админ)' },
      { command: 'broadcast', description: 'Рассылка (админ)' },
      { command: 'post', description: 'Лот в канал (админ)' },
      { command: 'setchannel', description: 'Указать канал (админ)' },
    ], { scope: { type: 'chat', chat_id: id } }).catch(() => {});
  }

  bot.on('pre_checkout_query', async (ctx) => {
    try {
      const [kind, idStr, uid] = ctx.preCheckoutQuery.invoice_payload.split(':');
      const { rows } = await q('SELECT status, seller_id, (ends_at > now()) AS live FROM auctions WHERE id=$1', [Number(idStr)]);
      const a = rows[0];
      const okOwner = a && String(a.seller_id) === String(uid);
      if (kind === 'list' && okOwner && a.status === 'draft') return ctx.answerPreCheckoutQuery(true);
      if (kind === 'bump' && okOwner && a.status === 'active' && a.live) return ctx.answerPreCheckoutQuery(true);
      return ctx.answerPreCheckoutQuery(false, 'Лот больше недоступен для этой операции');
    } catch (e) {
      console.error('pre_checkout', e.message);
      return ctx.answerPreCheckoutQuery(false, 'Временная ошибка, попробуйте позже');
    }
  });

  bot.on('message:successful_payment', async (ctx) => {
    const sp = ctx.message.successful_payment;
    const [kind, idStr] = sp.invoice_payload.split(':');
    const id = Number(idStr);
    const userId = ctx.from.id;
    try {
      const ins = await q(
        `INSERT INTO payments(user_id, kind, auction_id, method, amount, charge_id) VALUES ($1,$2,$3,'stars',$4,$5)
         ON CONFLICT (charge_id) DO NOTHING RETURNING id`,
        [userId, kind, id, sp.total_amount, sp.telegram_payment_charge_id]
      );
      if (!ins.rowCount) return; // already processed

      let ok = false;
      if (kind === 'list') {
        ok = !!(await activate(id, 'stars'));
      } else if (kind === 'bump') {
        const r = await q(`UPDATE auctions SET bumped_at=now() WHERE id=$1 AND status='active' AND ends_at > now()`, [id]);
        ok = r.rowCount > 0;
        if (ok) await ctx.reply('🔝 Лот поднят в начало списка.');
      }
      if (!ok) {
        await bot.api.refundStarPayment(userId, sp.telegram_payment_charge_id).catch((e) => console.error('refund', e.message));
        await ctx.reply('Лот уже недоступен — звёзды возвращены.');
      }
    } catch (e) {
      console.error('successful_payment', e);
    }
  });

  bot.catch((e) => console.error('bot error', e.message));
  if (WEBAPP_URL) {
    bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Аукцион', web_app: { url: WEBAPP_URL } } }).catch((e) => console.error('menu button', e.message));
  }
  bot.start({ drop_pending_updates: false, allowed_updates: ['message', 'callback_query', 'pre_checkout_query', 'my_chat_member', 'channel_post'] }).catch((e) => console.error('bot stopped', e.message));
}

await initDb();
app.listen(PORT, () => console.log(`Server on :${PORT}`));
await startBot();

const safe = (name, fn) => () => fn().catch((e) => console.error(name, e.message));
setInterval(safe('finish', finishAuctions), 30 * 1000);
setInterval(safe('remind', remindEnding), 60 * 1000);
setInterval(safe('digest', maybeSendDigest), 5 * 60 * 1000);
safe('finish', finishAuctions)();
safe('remind', remindEnding)();
safe('digest', maybeSendDigest)();
