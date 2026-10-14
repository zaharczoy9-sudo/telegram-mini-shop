import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { Bot, InlineKeyboard } from 'grammy';

pg.types.setTypeParser(1700, (v) => parseFloat(v)); // NUMERIC -> number
pg.types.setTypeParser(20, (v) => Number(v)); // BIGINT -> number

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- config ----------
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map((s) => s.trim()).filter(Boolean).map(Number);
const SHOP_NAME = process.env.SHOP_NAME || 'SAZY SHOP';
const CHANNEL = (process.env.CHANNEL || '').trim().replace(/^https?:\/\/t\.me\//, '').replace(/^@/, '');
const DEV_USER_ID = process.env.DEV_USER_ID ? Number(process.env.DEV_USER_ID) : null;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL = process.env.WEBAPP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');

const LISTING_STARS = Number(process.env.LISTING_STARS) || 50; // размещение лота, звёзды
const BUMP_STARS = Number(process.env.BUMP_STARS) || 25; // поднятие лота, звёзды
const LISTING_BYN = Number(process.env.LISTING_BYN) || 3; // размещение лота, BYN (ручное подтверждение)
const MAX_STEP = Number(process.env.MAX_STEP) || 10; // максимальный шаг ставки, BYN
const AUCTION_HOURS = Math.max(1, Math.round(Number(process.env.AUCTION_HOURS))) || 24;
const FREE_LISTING = process.env.FREE_LISTING !== 'false'; // размещение бесплатно (на время открытия)
const PAY_BYN_INFO = process.env.PAY_BYN_INFO || 'Реквизиты не заданы (переменная PAY_BYN_INFO)';

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set'); process.exit(1); }
if (!BOT_TOKEN && !DEV_USER_ID) { console.error('BOT_TOKEN is not set'); process.exit(1); }

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

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
      status TEXT NOT NULL DEFAULT 'draft', -- draft | pending_review | active | ended | cancelled
      pay_method TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      started_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      bumped_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS auctions_status_idx ON auctions(status, ends_at);

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
      method TEXT NOT NULL,         -- stars | byn | admin
      amount NUMERIC(10,2) NOT NULL DEFAULT 0,
      charge_id TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
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

function auth(req, res, next) {
  let user = validateInitData(req.get('X-Init-Data'));
  if (!user && DEV_USER_ID) user = { id: DEV_USER_ID, first_name: 'Dev', username: 'dev' };
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  req.isAdmin = ADMIN_IDS.includes(Number(user.id));
  req.displayName = clean(user.first_name || user.username || 'Участник', 40);
  next();
}
function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  next();
}

// ---------- bot ----------
let bot = null;

async function notify(userId, html, extra = {}) {
  if (!bot || !userId) return;
  try {
    await bot.api.sendMessage(userId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
  } catch (e) {
    console.error('notify failed', userId, e.message);
  }
}
const notifyAdmins = (html) => Promise.allSettled(ADMIN_IDS.map((id) => notify(id, html)));

const openAppKb = () => (WEBAPP_URL ? { reply_markup: new InlineKeyboard().webApp('Открыть аукцион', WEBAPP_URL) } : {});

// ---------- lifecycle ----------
async function activate(id, method) {
  const { rows } = await q(
    `UPDATE auctions
       SET status='active', pay_method=$2, started_at=now(), bumped_at=now(),
           ends_at = now() + make_interval(hours => $3)
     WHERE id=$1 AND status IN ('draft','pending_review')
     RETURNING *`,
    [id, method, AUCTION_HOURS]
  );
  const a = rows[0];
  if (a) {
    notify(a.seller_id, `✅ Лот №${a.id} «${h(a.title)}» опубликован.\nТорги идут ${AUCTION_HOURS} ч.`, openAppKb());
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
    } else {
      await notify(a.seller_id, `Лот №${a.id} «${h(a.title)}» завершён без ставок.`);
    }
  }
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
  avatar: !!CHANNEL,
  hours: AUCTION_HOURS,
  maxStep: MAX_STEP,
  freeListing: FREE_LISTING,
  fees: { listingStars: LISTING_STARS, listingByn: LISTING_BYN, bumpStars: BUMP_STARS },
}));

app.get('/api/me', auth, (req, res) => res.json({
  id: req.user.id,
  name: [req.user.first_name, req.user.last_name].filter(Boolean).join(' '),
  username: req.user.username || null,
  isAdmin: req.isAdmin,
  payInfo: PAY_BYN_INFO,
}));

// ---------- auctions: read ----------
const mapAuction = (a, userId) => ({
  id: a.id,
  title: a.title,
  description: a.description,
  size: a.size,
  city: a.city,
  contact: a.contact,
  image_ids: a.image_ids,
  images: a.image_ids.map((i) => `/img/${i}`),
  start_price: a.start_price,
  min_step: a.min_step,
  max_step: a.max_step,
  current_price: a.current_price,
  bids_count: a.bids_count,
  leader_name: a.leader_name,
  status: a.status,
  pay_method: a.pay_method,
  ends_at: a.ends_at,
  created_at: a.created_at,
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
  res.json({ now: new Date().toISOString(), item: mapAuction(a, req.user.id), bids });
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

  const { rows: cnt } = await q(`SELECT count(*)::int AS n FROM auctions WHERE seller_id=$1 AND status IN ('draft','pending_review')`, [req.user.id]);
  if (cnt[0].n >= 10) throw new HttpError(400, 'Слишком много неоплаченных лотов. Оплатите или удалите старые.');

  const { rows } = await q(
    `INSERT INTO auctions(seller_id, seller_name, title, description, size, city, contact, image_ids, start_price, min_step, max_step, current_price)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$9) RETURNING id`,
    [req.user.id, req.displayName, title, description, size, city, contact, image_ids, startPrice, minStep, MAX_STEP]
  );
  const id = rows[0].id;
  if (FREE_LISTING) {
    await activate(id, 'free');
    await q(`INSERT INTO payments(user_id, kind, auction_id, method, amount) VALUES ($1,'list',$2,'free',0)`, [req.user.id, id]);
    return res.json({ id, published: true });
  }
  res.json({ id });
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
  const a = await getOwnLot(req, ['draft', 'pending_review']);
  const link = await makeInvoice(`Размещение лота №${a.id}`, `Аукцион на ${AUCTION_HOURS} ч: ${a.title}`, `list:${a.id}:${req.user.id}`, 'Размещение лота', LISTING_STARS);
  res.json({ link });
}));

app.post('/api/auctions/:id/pay/byn', auth, wrap(async (req, res) => {
  const a = await getOwnLot(req, ['draft']);
  await q(`UPDATE auctions SET status='pending_review', pay_method='byn' WHERE id=$1`, [a.id]);
  notifyAdmins(
    `💳 Оплата ${fmt(LISTING_BYN)} BYN на проверке\nЛот №${a.id} «${h(a.title)}»\nПродавец: ${userLink(a.seller_id, a.seller_name)}\nПодтвердите в админке мини-приложения.`
  );
  res.json({ ok: true });
}));

app.post('/api/auctions/:id/publish-free', auth, adminOnly, wrap(async (req, res) => {
  const a = await getOwnLot(req, ['draft', 'pending_review']);
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
    const canCancel = ['draft', 'pending_review'].includes(a.status) || (a.status === 'active' && a.bids_count === 0);
    if (!canCancel) throw new HttpError(400, 'Лот со ставками отменить нельзя');
  }
  await q(`UPDATE auctions SET status='cancelled' WHERE id=$1`, [a.id]);
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
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  if (prevLeader) notify(prevLeader, `⚡ Вашу ставку перебили на лоте «${h(a.title)}». Сейчас ${fmt(amount)} BYN.`, openAppKb());
  notify(a.seller_id, `💰 Новая ставка на лот «${h(a.title)}»: ${fmt(amount)} BYN (${h(req.displayName)})`);
  res.json({ ok: true, current_price: amount });
}));

// ---------- admin ----------
app.get('/api/admin/auctions', auth, adminOnly, wrap(async (req, res) => {
  const status = req.query.status;
  const { rows } = await q(
    `SELECT a.* FROM auctions a WHERE ($1::text IS NULL OR a.status=$1) AND a.status <> 'draft' ORDER BY a.id DESC LIMIT 100`,
    [status || null]
  );
  res.json({ now: new Date().toISOString(), items: rows.map((a) => ({ ...mapAuction(a, req.user.id), seller_id: a.seller_id, seller_name: a.seller_name })) });
}));

app.post('/api/admin/auctions/:id/approve', auth, adminOnly, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const a = await activate(id, 'byn');
  if (!a) throw new HttpError(400, 'Лот уже обработан');
  await q(`INSERT INTO payments(user_id, kind, auction_id, method, amount) VALUES ($1,'list',$2,'byn',$3)`, [a.seller_id, a.id, LISTING_BYN]);
  res.json({ ok: true });
}));

app.post('/api/admin/auctions/:id/reject', auth, adminOnly, wrap(async (req, res) => {
  const { rows } = await q(`UPDATE auctions SET status='draft', pay_method=NULL WHERE id=$1 AND status='pending_review' RETURNING *`, [Number(req.params.id)]);
  const a = rows[0];
  if (!a) throw new HttpError(400, 'Лот уже обработан');
  notify(a.seller_id, `Оплата лота №${a.id} «${h(a.title)}» не найдена. Оплатите ещё раз (звёздами или переводом) и отправьте на проверку.`, openAppKb());
  res.json({ ok: true });
}));

// ---------- bot setup ----------
async function startBot() {
  if (!BOT_TOKEN) { console.warn('BOT_TOKEN not set, bot disabled (DEV mode)'); return; }
  bot = new Bot(BOT_TOKEN);

  bot.command('start', (ctx) => {
    if (!WEBAPP_URL) return ctx.reply('WEBAPP_URL не задан.');
    return ctx.reply(`Добро пожаловать в ${SHOP_NAME}! Здесь можно выставлять вещи на аукцион и делать ставки.`, {
      reply_markup: new InlineKeyboard().webApp('Открыть аукцион', WEBAPP_URL),
    });
  });

  bot.on('pre_checkout_query', async (ctx) => {
    try {
      const [kind, idStr, uid] = ctx.preCheckoutQuery.invoice_payload.split(':');
      const { rows } = await q('SELECT status, seller_id, (ends_at > now()) AS live FROM auctions WHERE id=$1', [Number(idStr)]);
      const a = rows[0];
      const okOwner = a && String(a.seller_id) === String(uid);
      if (kind === 'list' && okOwner && ['draft', 'pending_review'].includes(a.status)) return ctx.answerPreCheckoutQuery(true);
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
  bot.start({ drop_pending_updates: false, allowed_updates: ['message', 'pre_checkout_query'] }).catch((e) => console.error('bot stopped', e.message));
}

await initDb();
app.listen(PORT, () => console.log(`Server on :${PORT}`));
await startBot();
setInterval(() => finishAuctions().catch((e) => console.error('finish', e.message)), 30 * 1000);
finishAuctions().catch((e) => console.error('finish', e.message));
