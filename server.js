import express from 'express';
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { Bot, InlineKeyboard } from 'grammy';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map(Number);
const SHOP_NAME = process.env.SHOP_NAME || 'My Store';
const DEV_USER_ID = process.env.DEV_USER_ID ? Number(process.env.DEV_USER_ID) : null;
const PORT = process.env.PORT || 3000;
const WEBAPP_URL =
  process.env.WEBAPP_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
if (!BOT_TOKEN && !DEV_USER_ID) {
  console.error('BOT_TOKEN is not set');
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
});
const q = (text, params) => pool.query(text, params);

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS images (
      id SERIAL PRIMARY KEY,
      mime TEXT NOT NULL,
      data BYTEA NOT NULL
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL DEFAULT 0,
      category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      image_ids INTEGER[] NOT NULL DEFAULT '{}',
      in_stock BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS favorites (
      user_id BIGINT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS cart_items (
      user_id BIGINT NOT NULL,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      PRIMARY KEY (user_id, product_id)
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL,
      username TEXT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      comment TEXT NOT NULL DEFAULT '',
      items JSONB NOT NULL,
      total INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'new',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ---------- Telegram initData validation ----------
function validateInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const str = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  const a = Buffer.from(calc);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
  if (age > 60 * 60 * 24 * 7) return null;
  try {
    return JSON.parse(params.get('user'));
  } catch {
    return null;
  }
}

function auth(req, res, next) {
  let user = validateInitData(req.get('X-Init-Data'));
  if (!user && DEV_USER_ID) user = { id: DEV_USER_ID, first_name: 'Dev', username: 'dev' };
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  req.isAdmin = ADMIN_IDS.includes(Number(user.id));
  next();
}

function adminOnly(req, res, next) {
  if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });
  next();
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((e) => {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  });

// ---------- App ----------
const app = express();
app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.send('ok'));

app.get(
  '/img/:id',
  wrap(async (req, res) => {
    const { rows } = await q('SELECT mime, data FROM images WHERE id=$1', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).end();
    res.set('Content-Type', rows[0].mime);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(rows[0].data);
  })
);

app.post(
  '/api/admin/upload',
  auth,
  adminOnly,
  express.raw({ type: 'image/*', limit: '6mb' }),
  wrap(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'no file' });
    const { rows } = await q('INSERT INTO images(mime, data) VALUES ($1,$2) RETURNING id', [
      req.get('Content-Type').split(';')[0],
      req.body,
    ]);
    res.json({ id: rows[0].id });
  })
);

app.use('/api', express.json({ limit: '1mb' }));

const mapProduct = (p) => ({
  id: p.id,
  title: p.title,
  description: p.description,
  price: p.price,
  category_id: p.category_id,
  category: p.category,
  in_stock: p.in_stock,
  image_ids: p.image_ids,
  images: p.image_ids.map((i) => `/img/${i}`),
  fav: !!p.fav,
  in_cart: !!p.in_cart,
});

app.get('/api/config', (_req, res) => res.json({ shopName: SHOP_NAME }));

app.get('/api/me', auth, (req, res) =>
  res.json({
    id: req.user.id,
    name: [req.user.first_name, req.user.last_name].filter(Boolean).join(' '),
    username: req.user.username || null,
    isAdmin: req.isAdmin,
  })
);

app.get(
  '/api/categories',
  auth,
  wrap(async (_req, res) => {
    const { rows } = await q('SELECT id, name FROM categories ORDER BY name');
    res.json(rows);
  })
);

app.get(
  '/api/products',
  auth,
  wrap(async (req, res) => {
    const search = String(req.query.q || '').slice(0, 100);
    const cat = req.query.category ? Number(req.query.category) : null;
    const favOnly = req.query.fav === '1';
    const order =
      { price_asc: 'p.price ASC', price_desc: 'p.price DESC', new: 'p.id DESC' }[req.query.sort] || 'p.id DESC';
    const { rows } = await q(
      `SELECT p.*, c.name AS category,
         EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=$1 AND f.product_id=p.id) AS fav,
         EXISTS(SELECT 1 FROM cart_items ci WHERE ci.user_id=$1 AND ci.product_id=p.id) AS in_cart
       FROM products p LEFT JOIN categories c ON c.id=p.category_id
       WHERE ($2::text='' OR p.title ILIKE '%'||$2||'%')
         AND ($3::int IS NULL OR p.category_id=$3)
         AND ($4::bool = false OR EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=$1 AND f.product_id=p.id))
       ORDER BY p.in_stock DESC, ${order}
       LIMIT 500`,
      [req.user.id, search, cat, favOnly]
    );
    res.json(rows.map(mapProduct));
  })
);

// favorites
app.post(
  '/api/favorites/:id',
  auth,
  wrap(async (req, res) => {
    await q('INSERT INTO favorites(user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      req.user.id,
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  })
);
app.delete(
  '/api/favorites/:id',
  auth,
  wrap(async (req, res) => {
    await q('DELETE FROM favorites WHERE user_id=$1 AND product_id=$2', [req.user.id, Number(req.params.id)]);
    res.json({ ok: true });
  })
);

// cart
app.get(
  '/api/cart',
  auth,
  wrap(async (req, res) => {
    const { rows } = await q(
      `SELECT p.*, c.name AS category, TRUE AS in_cart,
         EXISTS(SELECT 1 FROM favorites f WHERE f.user_id=$1 AND f.product_id=p.id) AS fav
       FROM cart_items ci JOIN products p ON p.id=ci.product_id
       LEFT JOIN categories c ON c.id=p.category_id
       WHERE ci.user_id=$1 ORDER BY p.id DESC`,
      [req.user.id]
    );
    res.json(rows.map(mapProduct));
  })
);
app.post(
  '/api/cart/:id',
  auth,
  wrap(async (req, res) => {
    const { rows } = await q('SELECT in_stock FROM products WHERE id=$1', [Number(req.params.id)]);
    if (!rows.length || !rows[0].in_stock) return res.status(400).json({ error: 'Товар недоступен' });
    await q('INSERT INTO cart_items(user_id, product_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [
      req.user.id,
      Number(req.params.id),
    ]);
    res.json({ ok: true });
  })
);
app.delete(
  '/api/cart/:id',
  auth,
  wrap(async (req, res) => {
    await q('DELETE FROM cart_items WHERE user_id=$1 AND product_id=$2', [req.user.id, Number(req.params.id)]);
    res.json({ ok: true });
  })
);

// orders
const clean = (v, n) => String(v || '').trim().slice(0, n);

app.post(
  '/api/orders',
  auth,
  wrap(async (req, res) => {
    const name = clean(req.body.name, 100);
    const phone = clean(req.body.phone, 40);
    const comment = clean(req.body.comment, 500);
    if (!name || !phone) return res.status(400).json({ error: 'Укажите имя и телефон' });

    const client = await pool.connect();
    let order;
    try {
      await client.query('BEGIN');
      const { rows: items } = await client.query(
        `SELECT p.id, p.title, p.price FROM cart_items ci
         JOIN products p ON p.id=ci.product_id
         WHERE ci.user_id=$1 AND p.in_stock=TRUE FOR UPDATE OF p`,
        [req.user.id]
      );
      if (!items.length) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Корзина пуста или товары уже проданы' });
      }
      const total = items.reduce((s, i) => s + i.price, 0);
      const ins = await client.query(
        `INSERT INTO orders(user_id, username, name, phone, comment, items, total)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [req.user.id, req.user.username || null, name, phone, comment, JSON.stringify(items), total]
      );
      order = ins.rows[0];
      await client.query('UPDATE products SET in_stock=FALSE WHERE id = ANY($1::int[])', [items.map((i) => i.id)]);
      await client.query('DELETE FROM cart_items WHERE user_id=$1', [req.user.id]);
      // remove sold items from other people's carts
      await client.query('DELETE FROM cart_items WHERE product_id = ANY($1::int[])', [items.map((i) => i.id)]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    notifyAdmins(order).catch((e) => console.error('notify failed', e.message));
    res.json({ id: order.id });
  })
);

app.get(
  '/api/orders',
  auth,
  wrap(async (req, res) => {
    const { rows } = await q('SELECT * FROM orders WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]);
    res.json(rows);
  })
);

// ---------- Admin ----------
app.get(
  '/api/admin/orders',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const status = req.query.status;
    const { rows } = await q(
      `SELECT * FROM orders WHERE ($1::text IS NULL OR status=$1) ORDER BY id DESC LIMIT 200`,
      [status || null]
    );
    res.json(rows);
  })
);

const STATUSES = ['new', 'confirmed', 'done', 'cancelled'];
app.put(
  '/api/admin/orders/:id/status',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const status = req.body.status;
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'bad status' });
    const { rows } = await q('SELECT * FROM orders WHERE id=$1', [Number(req.params.id)]);
    if (!rows.length) return res.status(404).json({ error: 'not found' });
    const order = rows[0];
    if (order.status !== 'cancelled' && status === 'cancelled') {
      await q('UPDATE products SET in_stock=TRUE WHERE id = ANY($1::int[])', [order.items.map((i) => i.id)]);
    }
    if (order.status === 'cancelled' && status !== 'cancelled') {
      await q('UPDATE products SET in_stock=FALSE WHERE id = ANY($1::int[])', [order.items.map((i) => i.id)]);
    }
    await q('UPDATE orders SET status=$1 WHERE id=$2', [status, order.id]);
    if (bot) {
      const text = {
        confirmed: `Ваш заказ №${order.id} подтверждён ✅`,
        done: `Заказ №${order.id} выполнен. Спасибо за покупку! 🙌`,
        cancelled: `Заказ №${order.id} отменён.`,
      }[status];
      if (text) bot.api.sendMessage(order.user_id, text).catch(() => {});
    }
    res.json({ ok: true });
  })
);

app.post(
  '/api/admin/categories',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const name = clean(req.body.name, 60);
    if (!name) return res.status(400).json({ error: 'name required' });
    const { rows } = await q(
      'INSERT INTO categories(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name=EXCLUDED.name RETURNING id, name',
      [name]
    );
    res.json(rows[0]);
  })
);
app.delete(
  '/api/admin/categories/:id',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    await q('DELETE FROM categories WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  })
);

function parseProduct(body) {
  const title = clean(body.title, 150);
  const price = Math.max(0, Math.round(Number(body.price) || 0));
  if (!title) return null;
  return {
    title,
    description: clean(body.description, 3000),
    price,
    category_id: body.category_id ? Number(body.category_id) : null,
    image_ids: Array.isArray(body.image_ids) ? body.image_ids.map(Number).filter(Number.isInteger).slice(0, 10) : [],
    in_stock: body.in_stock !== false,
  };
}

app.post(
  '/api/admin/products',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const p = parseProduct(req.body);
    if (!p) return res.status(400).json({ error: 'title required' });
    const { rows } = await q(
      `INSERT INTO products(title, description, price, category_id, image_ids, in_stock)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [p.title, p.description, p.price, p.category_id, p.image_ids, p.in_stock]
    );
    res.json({ id: rows[0].id });
  })
);
app.put(
  '/api/admin/products/:id',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    const p = parseProduct(req.body);
    if (!p) return res.status(400).json({ error: 'title required' });
    await q(
      `UPDATE products SET title=$1, description=$2, price=$3, category_id=$4, image_ids=$5, in_stock=$6 WHERE id=$7`,
      [p.title, p.description, p.price, p.category_id, p.image_ids, p.in_stock, Number(req.params.id)]
    );
    if (!p.in_stock) await q('DELETE FROM cart_items WHERE product_id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  })
);
app.delete(
  '/api/admin/products/:id',
  auth,
  adminOnly,
  wrap(async (req, res) => {
    await q('DELETE FROM products WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  })
);

// ---------- Bot ----------
let bot = null;

async function notifyAdmins(order) {
  if (!bot || !ADMIN_IDS.length) return;
  const lines = order.items.map((i) => `• ${i.title} — ${i.price} ₽`).join('\n');
  const contact = order.username ? `@${order.username}` : `tg://user?id=${order.user_id}`;
  const text =
    `🛒 Новый заказ №${order.id}\n\n${lines}\n\nИтого: ${order.total} ₽\n\n` +
    `Имя: ${order.name}\nТелефон: ${order.phone}\nTelegram: ${contact}` +
    (order.comment ? `\nКомментарий: ${order.comment}` : '');
  await Promise.allSettled(ADMIN_IDS.map((id) => bot.api.sendMessage(id, text)));
}

async function startBot() {
  if (!BOT_TOKEN) {
    console.warn('BOT_TOKEN not set, bot disabled (DEV mode)');
    return;
  }
  bot = new Bot(BOT_TOKEN);
  bot.command('start', (ctx) => {
    if (!WEBAPP_URL) return ctx.reply('WEBAPP_URL не задан.');
    return ctx.reply(`Добро пожаловать в ${SHOP_NAME}!`, {
      reply_markup: new InlineKeyboard().webApp('🛍 Открыть магазин', WEBAPP_URL),
    });
  });
  bot.catch((e) => console.error('bot error', e.message));
  if (WEBAPP_URL) {
    bot.api
      .setChatMenuButton({ menu_button: { type: 'web_app', text: 'Магазин', web_app: { url: WEBAPP_URL } } })
      .catch((e) => console.error('menu button', e.message));
  }
  bot.start({ drop_pending_updates: true }).catch((e) => console.error('bot stopped', e.message));
}

await initDb();
app.listen(PORT, () => console.log(`Server on :${PORT}`));
await startBot();
