const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();
tg?.enableClosingConfirmation();

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rub = (n) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n) + ' BYN';

const S = {
  tab: 'catalog', me: null, shopName: 'SAZY SHOP', cats: [], q: '', sort: 'new', cat: null,
  cartCount: 0, adminTab: 'products', orderFilter: '',
};

const ICON = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  sort: '<svg viewBox="0 0 24 24"><path d="M8 4v16M4 16l4 4 4-4M16 20V4m-4 4l4-4 4 4"/></svg>',
  cart: '<svg viewBox="0 0 24 24"><path d="M3 4h2l2.4 11h10.2L20 7H6"/><circle cx="9" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.5 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/></svg>',
  ban: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M6.5 6.5l11 11"/></svg>',
};

async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'X-Init-Data': tg?.initData || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'ÐÑÐ¸Ð±ÐºÐ° ' + r.status);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2200);
}

const haptic = () => tg?.HapticFeedback?.impactOccurred?.('light');

function sheet(html, onMount) {
  const root = $('#sheetRoot');
  root.innerHTML = `<div class="shade"><div class="sheet">${html}</div></div>`;
  const shade = root.firstChild;
  shade.addEventListener('click', (e) => { if (e.target === shade) closeSheet(); });
  onMount?.(root.querySelector('.sheet'));
}

function closeSheet() { $('#sheetRoot').innerHTML = ''; }

function setBadge(n) {
  S.cartCount = n;
  const b = $('#badge');
  if (b) { b.hidden = !n; b.textContent = n; }
}

async function refreshBadge() {
  try { setBadge((await api('/cart')).length); } catch {}
}

function cardHtml(p) {
  const img = p.images[0] ? `<img loading="lazy" src="${p.images[0]}" alt="">` : '';
  return `<div class="card" data-id="${p.id}">
    <div class="ph" data-act="open">${img}${p.in_stock ? '' : '<span class="sold">ÐÑÐ¾Ð´Ð°Ð½Ð¾</span>'}</div>
    <h3 data-act="open">${esc(p.title)}</h3>
    <div class="acts">
      <button class="ib ${p.in_stock ? (p.in_cart ? 'on' : '') : 'dis'}" data-act="cart" ${p.in_stock ? '' : 'disabled'}>${p.in_stock ? ICON.cart : ICON.ban}</button>
      <button class="ib heart ${p.fav ? 'on' : ''}" data-act="fav">${ICON.heart}</button>
      <span class="price">${rub(p.price)}</span>
    </div>
  </div>`;
}

let PRODUCTS = [];
async function loadProducts(favOnly) {
  const params = new URLSearchParams();
  if (S.q) params.set('q', S.q);
  if (S.sort) params.set('sort', S.sort);
  if (S.cat && !favOnly) params.set('category', S.cat);
  if (favOnly) params.set('fav', '1');
  PRODUCTS = await api('/products?' + params);
  return PRODUCTS;
}

function renderGrid(list, emptyText) {
  const g = $('#grid');
  if (!g) return;
  g.innerHTML = list.length ? list.map(cardHtml).join('') : `<div class="empty" style="grid-column:1/-1">${emptyText}</div>`;
}

async function viewCatalog() {
  $('#top').innerHTML = `
    <div class="header-row">
      <div class="logo">${S.avatar ? `<img src="/avatar.jpg" alt="" onerror="this.remove()">` : ''}${esc((S.shopName || 'S')[0])}</div>
      <h1 class="title">${esc(S.shopName)}</h1>
    </div>
    <div class="row">
      <label class="search">${ICON.search}<input id="q" placeholder="ÐÐ°Ð¹ÑÐ¸..." value="${esc(S.q)}"></label>
      <button class="sqbtn" id="sortBtn">${ICON.sort}</button>
    </div>
    <div class="chips" id="chips"></div>
  `;
  $('#view').innerHTML = '<div class="grid" id="grid"></div>';
  
  drawChips();
  let timer;
  $('#q').addEventListener('input', (e) => {
    S.q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      renderGrid(await loadProducts(false), 'ÐÐ¸ÑÐµÐ³Ð¾ Ð½Ðµ Ð½Ð°Ð¹Ð´ÐµÐ½Ð¾');
    }, 300);
  });

  $('#sortBtn').onclick = () => {
    const opts = [['new', 'Ð¡Ð½Ð°ÑÐ°Ð»Ð° Ð½Ð¾Ð²ÑÐµ'], ['price_asc', 'Ð¡Ð½Ð°ÑÐ°Ð»Ð° Ð´ÐµÑÑÐ²ÑÐµ'], ['price_desc', 'Ð¡Ð½Ð°ÑÐ°Ð»Ð° Ð´Ð¾ÑÐ¾Ð³Ð¸Ðµ']];
    sheet(
      `<h2>Ð¡Ð¾ÑÑÐ¸ÑÐ¾Ð²ÐºÐ°</h2>${opts.map(([k, l]) => `<button class="opt ${S.sort === k ? 'on' : ''}" data-sort="${k}">${l}</button>`).join('')}`,
      (el) => el.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = async () => {
        S.sort = b.dataset.sort;
        closeSheet();
        renderGrid(await loadProducts(false), 'ÐÐ¸ÑÐµÐ³Ð¾ Ð½Ðµ Ð½Ð°Ð¹Ð´ÐµÐ½Ð¾');
      }))
    );
  };

  renderGrid(await loadProducts(false), 'ÐÐ¾ÐºÐ° Ð½ÐµÑ ÑÐ¾Ð²Ð°ÑÐ¾Ð²');
}

function drawChips() {
  const c = $('#chips');
  if (!c) return;
  if (!S.cats.length) { c.style.display = 'none'; return; }
  c.innerHTML = `<button class="chip ${S.cat ? '' : 'on'}" data-cat="">ÐÑÐµ</button>` +
    S.cats.map((x) => `<button class="chip ${S.cat === x.id ? 'on' : ''}" data-cat="${x.id}">${esc(x.name)}</button>`).join('');
  c.querySelectorAll('.chip').forEach((b) => (b.onclick = async () => {
    S.cat = b.dataset.cat ? Number(b.dataset.cat) : null;
    drawChips();
    renderGrid(await loadProducts(false), 'ÐÐ¸ÑÐµÐ³Ð¾ Ð½Ðµ Ð½Ð°Ð¹Ð´ÐµÐ½Ð¾');
  }));
}

async function viewFavs() {
  $('#top').innerHTML = '<h1 class="title">ÐÐ·Ð±ÑÐ°Ð½Ð½Ð¾Ðµ</h1>';
  $('#view').innerHTML = '<div class="grid" id="grid"></div>';
  const prevQ = S.q; S.q = '';
  renderGrid(await loadProducts(true), 'ÐÐ´ÐµÑÑ Ð¿Ð¾ÐºÐ° Ð¿ÑÑÑÐ¾. ÐÐ°Ð¶Ð¼Ð¸ÑÐµ â¡ Ð½Ð° Ð¿Ð¾Ð½ÑÐ°Ð²Ð¸Ð²ÑÐµÐ¼ÑÑ ÑÐ¾Ð²Ð°ÑÐµ');
  S.q = prevQ;
}

document.addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]');
  const card = e.target.closest('.card');
  if (!act || !card) return;
  const id = Number(card.dataset.id);
  const p = PRODUCTS.find((x) => x.id === id);
  if (!p) return;
  try {
    if (act.dataset.act === 'open') return openProduct(p);
    if (act.dataset.act === 'fav') {
      await api('/favorites/' + id, p.fav ? 'DELETE' : 'POST');
      p.fav = !p.fav; haptic();
      if (S.tab === 'favs' && !p.fav) card.remove();
      else act.classList.toggle('on', p.fav);
    }
    if (act.dataset.act === 'cart') {
      await api('/cart/' + id, p.in_cart ? 'DELETE' : 'POST');
      p.in_cart = !p.in_cart;
      act.classList.toggle('on', p.in_cart); haptic();
      toast(p.in_cart ? 'ÐÐ¾Ð±Ð°Ð²Ð»ÐµÐ½Ð¾ Ð² ÐºÐ¾ÑÐ·Ð¸Ð½Ñ' : 'Ð£Ð±ÑÐ°Ð½Ð¾ Ð¸Ð· ÐºÐ¾ÑÐ·Ð¸Ð½Ñ');
      refreshBadge();
    }
  } catch (err) { toast(err.message); }
});

function openProduct(p) {
  sheet(
    `${p.images.length ? `<div class="gallery">${p.images.map((i) => `<img src="${i}" alt="">`).join('')}</div>` : ''}
    <h2>${esc(p.title)}</h2>
    <div style="font-size:24px;font-weight:800;margin-bottom:8px">${rub(p.price)}</div>
    ${p.category ? `<div style="color:var(--muted);margin-bottom:8px;font-size:14px">${esc(p.category)}</div>` : ''}
    <p style="white-space:pre-wrap;margin:0 0 20px;color:#4b5563;line-height:1.5">${esc(p.description) || ''}</p>
    ${p.in_stock ? `<button class="btn" id="pcart">${p.in_cart ? 'Ð£Ð±ÑÐ°ÑÑ Ð¸Ð· ÐºÐ¾ÑÐ·Ð¸Ð½Ñ' : 'Ð ÐºÐ¾ÑÐ·Ð¸Ð½Ñ'}</button>` : '<button class="btn sec" disabled>ÐÑÐ¾Ð´Ð°Ð½Ð¾</button>'}`,
    (el) => {
      const b = el.querySelector('#pcart');
      if (b) b.onclick = async () => {
        try {
          await api('/cart/' + p.id, p.in_cart ? 'DELETE' : 'POST');
          p.in_cart = !p.in_cart;
          b.textContent = p.in_cart ? 'Ð£Ð±ÑÐ°ÑÑ Ð¸Ð· ÐºÐ¾ÑÐ·Ð¸Ð½Ñ' : 'Ð ÐºÐ¾ÑÐ·Ð¸Ð½Ñ';
          refreshBadge();
          document.querySelector(`.card[data-id="${p.id}"] [data-act="cart"]`)?.classList.toggle('on', p.in_cart);
        } catch (err) { toast(err.message); }
      };
    }
  );
}

async function viewCart() {
  $('#top').innerHTML = '<h1 class="title">ÐÐ¾ÑÐ·Ð¸Ð½Ð°</h1>';
  const items = await api('/cart');
  setBadge(items.length);
  const v = $('#view');
  if (!items.length) { v.innerHTML = '<div class="empty">ÐÐ¾ÑÐ·Ð¸Ð½Ð° Ð¿ÑÑÑÐ°</div>'; return; }
  
  const total = items.reduce((s, i) => s + i.price, 0);
  const unavailable = items.some((i) => !i.in_stock);
  
  v.innerHTML = `
    <div class="list">${items.map((p) => `<div class="item" data-id="${p.id}">
      <img src="${p.images[0] || ''}" alt="">
      <div class="info"><b>${esc(p.title)}</b><small>${rub(p.price)}</small></div>
      <button class="ib" data-rm="${p.id}" aria-label="Ð£Ð´Ð°Ð»Ð¸ÑÑ">â</button>
    </div>`).join('')}</div>
    <div class="total"><span>ÐÑÐ¾Ð³Ð¾</span><span>${rub(total)}</span></div>
    <div class="box">
      <h4>ÐÑÐ¾ÑÐ¼Ð»ÐµÐ½Ð¸Ðµ Ð·Ð°ÐºÐ°Ð·Ð°</h4>
      <label>ÐÐ¼Ñ</label><input class="f" id="oname" value="${esc(S.me?.name || '')}">
      <label>Ð¢ÐµÐ»ÐµÑÐ¾Ð½</label><input class="f" id="ophone" type="tel" placeholder="+7 ...">
      <label>ÐÐ¾Ð¼Ð¼ÐµÐ½ÑÐ°ÑÐ¸Ð¹</label><textarea class="f" id="ocomment" placeholder="Ð Ð°Ð·Ð¼ÐµÑ, Ð°Ð´ÑÐµÑ Ð´Ð¾ÑÑÐ°Ð²ÐºÐ¸, Ð¿Ð¾Ð¶ÐµÐ»Ð°Ð½Ð¸Ñ"></textarea>
    </div>
    <button class="btn" id="order" ${unavailable ? 'disabled' : ''}>ÐÑÐ¾ÑÐ¼Ð¸ÑÑ Ð·Ð°ÐºÐ°Ð·</button>
  `;

  v.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
    await api('/cart/' + b.dataset.rm, 'DELETE'); viewCart();
  }));

  $('#order').onclick = async (e) => {
    const name = $('#oname').value.trim();
    const phone = $('#ophone').value.trim();
    if (!name || !phone) return toast('Ð£ÐºÐ°Ð¶Ð¸ÑÐµ Ð¸Ð¼Ñ Ð¸ ÑÐµÐ»ÐµÑÐ¾Ð½');
    e.target.disabled = true;
    try {
      const r = await api('/orders', 'POST', { name, phone, comment: $('#ocomment').value });
      setBadge(0);
      $('#view').innerHTML = `<div class="empty"><div style="font-size:56px;margin-bottom:10px"></div><h2 style="margin-bottom:8px">ÐÐ°ÐºÐ°Ð· â${r.id} Ð¾ÑÐ¾ÑÐ¼Ð»ÐµÐ½</h2><p style="color:var(--muted)">ÐÑ ÑÐ²ÑÐ¶ÐµÐ¼ÑÑ Ñ Ð²Ð°Ð¼Ð¸ Ð² Ð±Ð»Ð¸Ð¶Ð°Ð¹ÑÐµÐµ Ð²ÑÐµÐ¼Ñ.</p></div>`;
      tg?.HapticFeedback?.notificationOccurred?.('success');
    } catch (err) { toast(err.message); e.target.disabled = false; }
  };
}

const STATUS_RU = { new: 'ÐÐ¾Ð²ÑÐ¹', confirmed: 'ÐÐ¾Ð´ÑÐ²ÐµÑÐ¶Ð´ÑÐ½', done: 'ÐÑÐ¿Ð¾Ð»Ð½ÐµÐ½', cancelled: 'ÐÑÐ¼ÐµÐ½ÑÐ½' };
const fmtDate = (d) => new Date(d).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function orderHtml(o, admin) {
  return `<div class="box" data-oid="${o.id}">
    <div class="row" style="justify-content:space-between"><b>ÐÐ°ÐºÐ°Ð· â${o.id}</b><span class="st ${o.status}">${STATUS_RU[o.status]}</span></div>
    <div style="color:var(--muted);font-size:13px;margin:4px 0 10px">${fmtDate(o.created_at)}</div>
    ${o.items.map((i) => `<div class="row" style="justify-content:space-between"><span>${esc(i.title)}</span><span>${rub(i.price)}</span></div>`).join('')}
    <div class="row" style="justify-content:space-between;margin-top:10px"><b>ÐÑÐ¾Ð³Ð¾</b><b>${rub(o.total)}</b></div>
    ${admin ? `<hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
      <div style="font-weight:500">${esc(o.name)} Â· ${esc(o.phone)}</div>
      <div style="color:var(--muted);font-size:14px">${o.username ? `<a href="https://t.me/${esc(o.username)}" style="color:var(--accent);text-decoration:none">@${esc(o.username)}</a>` : `id ${o.user_id}`}</div>
      ${o.comment ? `<div style="margin-top:6px;color:#4b5563">ð¬ ${esc(o.comment)}</div>` : ''}
      <div class="row" style="margin-top:12px;flex-wrap:wrap;gap:8px">
        ${['confirmed', 'done', 'cancelled'].filter((s) => s !== o.status).map((s) => `<button class="btn sm ${s === 'cancelled' ? 'danger' : 'sec'}" data-status="${s}">${STATUS_RU[s]}</button>`).join('')}
      </div>` : ''}
  </div>`;
}

async function viewProfile() {
  $('#top').innerHTML = '<h1 class="title">ÐÑÐ¾ÑÐ¸Ð»Ñ</h1>';
  const orders = await api('/orders');
  $('#view').innerHTML = `
    <div class="box">
      <b style="font-size:18px">${esc(S.me?.name || 'ÐÐ¾ÑÑÑ')}</b>
      <div style="color:var(--muted);margin-top:4px">${S.me?.username ? '@' + esc(S.me.username) : ''}</div>
    </div>
    <h3 style="margin:20px 4px 12px;font-size:18px">ÐÐ¾Ð¸ Ð·Ð°ÐºÐ°Ð·Ñ</h3>
    ${orders.length ? orders.map((o) => orderHtml(o, false)).join('') : '<div class="empty">ÐÐ°ÐºÐ°Ð·Ð¾Ð² Ð¿Ð¾ÐºÐ° Ð½ÐµÑ</div>'}
  `;
}

async function viewAdmin() {
  $('#top').innerHTML = '<h1 class="title">ÐÐ´Ð¼Ð¸Ð½-Ð¿Ð°Ð½ÐµÐ»Ñ</h1>';
  const v = $('#view');
  v.innerHTML = `
    <div class="tabs">
      ${[['products', 'Ð¢Ð¾Ð²Ð°ÑÑ'], ['orders', 'ÐÐ°ÐºÐ°Ð·Ñ'], ['cats', 'ÐÐ°ÑÐµÐ³Ð¾ÑÐ¸Ð¸']].map(([k, l]) => `<button data-at="${k}" class="${S.adminTab === k ? 'on' : ''}">${l}</button>`).join('')}
    </div>
    <div id="adminBody"></div>
  `;
  v.querySelectorAll('[data-at]').forEach((b) => (b.onclick = () => { S.adminTab = b.dataset.at; viewAdmin(); }));
  
  const body = $('#adminBody');
  if (S.adminTab === 'products') await adminProducts(body);
  if (S.adminTab === 'orders') await adminOrders(body);
  if (S.adminTab === 'cats') await adminCats(body);
}

async function adminProducts(body) {
  const list = await api('/products?sort=new');
  PRODUCTS = list;
  body.innerHTML = `
    <button class="btn" id="addP" style="margin-bottom:16px">+ ÐÐ¾Ð±Ð°Ð²Ð¸ÑÑ ÑÐ¾Ð²Ð°Ñ</button>
    <div class="list">${list.map((p) => `<div class="item" data-edit="${p.id}">
      <img src="${p.images[0] || ''}" alt="">
      <div class="info"><b>${esc(p.title)}</b><small>${rub(p.price)} Â· ${p.in_stock ? 'Ð² Ð½Ð°Ð»Ð¸ÑÐ¸Ð¸' : 'Ð¿ÑÐ¾Ð´Ð°Ð½Ð¾'}</small></div>
      <span style="color:var(--muted)">âº</span>
    </div>`).join('')}</div>
  `;
  $('#addP').onclick = () => productForm(null);
  body.querySelectorAll('[data-edit]').forEach((el) => (el.onclick = () => productForm(list.find((p) => p.id === Number(el.dataset.edit)))));
}

async function resizeImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
}

async function uploadImage(file) {
  const blob = await resizeImage(file);
  const r = await fetch('/api/admin/upload', {
    method: 'POST',
    headers: { 'X-Init-Data': tg?.initData || '', 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  if (!r.ok) throw new Error('ÐÐµ ÑÐ´Ð°Ð»Ð¾ÑÑ Ð·Ð°Ð³ÑÑÐ·Ð¸ÑÑ ÑÐ¾ÑÐ¾');
  return (await r.json()).id;
}

function productForm(p) {
  let imgs = p ? [...p.image_ids] : [];
  sheet(
    `<h2>${p ? 'Ð ÐµÐ´Ð°ÐºÑÐ¸ÑÐ¾Ð²Ð°ÑÑ ÑÐ¾Ð²Ð°Ñ' : 'ÐÐ¾Ð²ÑÐ¹ ÑÐ¾Ð²Ð°Ñ'}</h2>
    <label>ÐÐ°Ð·Ð²Ð°Ð½Ð¸Ðµ</label><input class="f" id="ft" value="${esc(p?.title || '')}">
    <label>Ð¦ÐµÐ½Ð°, BYN</label><input class="f" id="fp" type="number" step="0.01" inputmode="decimal" value="${p?.price ?? ''}">
    <label>ÐÐ°ÑÐµÐ³Ð¾ÑÐ¸Ñ</label>
    <select class="f" id="fc"><option value="">ÐÐµÐ· ÐºÐ°ÑÐµÐ³Ð¾ÑÐ¸Ð¸</option>${S.cats.map((c) => `<option value="${c.id}" ${p?.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <label>ÐÐ¿Ð¸ÑÐ°Ð½Ð¸Ðµ</label><textarea class="f" id="fd">${esc(p?.description || '')}</textarea>
    <label>Ð¤Ð¾ÑÐ¾</label><div class="thumbs" id="thumbs"></div>
    <input type="file" id="ff" accept="image/*" multiple hidden>
    <div class="switch"><span>Ð Ð½Ð°Ð»Ð¸ÑÐ¸Ð¸</span><input type="checkbox" id="fs" ${p?.in_stock === false ? '' : 'checked'}></div>
    <button class="btn" id="save" style="margin-top:16px">Ð¡Ð¾ÑÑÐ°Ð½Ð¸ÑÑ</button>
    ${p ? '<button class="btn danger" id="del" style="margin-top:8px">Ð£Ð´Ð°Ð»Ð¸ÑÑ ÑÐ¾Ð²Ð°Ñ</button>' : ''}`,
    (el) => {
      const draw = () => {
        el.querySelector('#thumbs').innerHTML =
          imgs.map((id, i) => `<div class="th"><img src="/img/${id}"><button class="x" data-i="${i}">Ã</button></div>`).join('') +
          '<label class="addimg" for="ff">+</label>';
        el.querySelectorAll('.x').forEach((b) => (b.onclick = () => { imgs.splice(Number(b.dataset.i), 1); draw(); }));
      };
      draw();
      el.querySelector('#ff').onchange = async (e) => {
        toast('ÐÐ°Ð³ÑÑÐ¶Ð°Ñ ÑÐ¾ÑÐ¾...');
        try { for (const f of e.target.files) imgs.push(await uploadImage(f)); draw(); } catch (err) { toast(err.message); }
        e.target.value = '';
      };
      el.querySelector('#save').onclick = async () => {
        const body = {
          title: el.querySelector('#ft').value, price: el.querySelector('#fp').value,
          category_id: el.querySelector('#fc').value || null, description: el.querySelector('#fd').value,
          image_ids: imgs, in_stock: el.querySelector('#fs').checked,
        };
        if (!body.title.trim()) return toast('ÐÐ²ÐµÐ´Ð¸ÑÐµ Ð½Ð°Ð·Ð²Ð°Ð½Ð¸Ðµ');
        try {
          await api(p ? '/admin/products/' + p.id : '/admin/products', p ? 'PUT' : 'POST', body);
          closeSheet(); viewAdmin();
        } catch (err) { toast(err.message); }
      };
      el.querySelector('#del')?.addEventListener('click', async () => {
        if (!confirm('Ð£Ð´Ð°Ð»Ð¸ÑÑ ÑÐ¾Ð²Ð°Ñ?')) return;
        await api('/admin/products/' + p.id, 'DELETE'); closeSheet(); viewAdmin();
      });
    }
  );
}

async function adminOrders(body) {
  const orders = await api('/admin/orders' + (S.orderFilter ? '?status=' + S.orderFilter : ''));
  body.innerHTML = `
    <div class="chips" style="padding-top:0">
      ${[['', 'ÐÑÐµ'], ['new', 'ÐÐ¾Ð²ÑÐµ'], ['confirmed', 'ÐÐ¾Ð´ÑÐ²ÐµÑÐ¶Ð´ÑÐ½Ð½ÑÐµ'], ['done', 'ÐÑÐ¿Ð¾Ð»Ð½ÐµÐ½Ð½ÑÐµ'], ['cancelled', 'ÐÑÐ¼ÐµÐ½ÑÐ½Ð½ÑÐµ']].map(([k, l]) => `<button class="chip ${S.orderFilter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}
    </div>
    ${orders.length ? orders.map((o) => orderHtml(o, true)).join('') : '<div class="empty">ÐÐ°ÐºÐ°Ð·Ð¾Ð² Ð½ÐµÑ</div>'}
  `;
  body.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => { S.orderFilter = b.dataset.f; viewAdmin(); }));
  body.querySelectorAll('[data-status]').forEach((b) => (b.onclick = async () => {
    const id = b.closest('[data-oid]').dataset.oid;
    if (b.dataset.status === 'cancelled' && !confirm('ÐÑÐ¼ÐµÐ½Ð¸ÑÑ Ð·Ð°ÐºÐ°Ð·?')) return;
    try { await api(`/admin/orders/${id}/status`, 'PUT', { status: b.dataset.status }); viewAdmin(); } catch (err) { toast(err.message); }
  }));
}

async function adminCats(body) {
  S.cats = await api('/categories');
  body.innerHTML = `
    <div class="row" style="margin-bottom:16px">
      <input class="f" id="nc" placeholder="ÐÐ¾Ð²Ð°Ñ ÐºÐ°ÑÐµÐ³Ð¾ÑÐ¸Ñ">
      <button class="btn sm" id="addC" style="white-space:nowrap">ÐÐ¾Ð±Ð°Ð²Ð¸ÑÑ</button>
    </div>
    <div class="list">${S.cats.map((c) => `<div class="item">
      <div class="info"><b>${esc(c.name)}</b></div>
      <button class="ib" data-dc="${c.id}">â</button>
    </div>`).join('')}</div>
  `;
  $('#addC').onclick = async () => {
    const name = $('#nc').value.trim();
    if (!name) return;
    await api('/admin/categories', 'POST', { name }); adminCats(body);
  };
  body.querySelectorAll('[data-dc]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Ð£Ð´Ð°Ð»Ð¸ÑÑ ÐºÐ°ÑÐµÐ³Ð¾ÑÐ¸Ñ?')) return;
    await api('/admin/categories/' + b.dataset.dc, 'DELETE'); adminCats(body);
  }));
}

async function render() {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  window.scrollTo(0, 0);
  try {
    if (S.tab === 'catalog') await viewCatalog();
    else if (S.tab === 'cart') await viewCart();
    else if (S.tab === 'favs') await viewFavs();
    else if (S.tab === 'profile') await viewProfile();
    else if (S.tab === 'admin' && S.me?.isAdmin) await viewAdmin();
    else if (S.tab === 'admin') { S.tab = 'catalog'; await viewCatalog(); }
  } catch (err) {
    $('#view').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => {
  S.tab = b.dataset.tab; closeSheet(); render();
}));

(async function init() {
  try {
    const [cfg, me, cats] = await Promise.all([api('/config'), api('/me'), api('/categories')]);
    S.shopName = cfg.shopName; S.avatar = cfg.avatar; S.me = me; S.cats = cats;
    document.title = cfg.shopName;
    
    const adminBtn = document.querySelector('#nav button[data-tab="admin"]');
    if (adminBtn) {
      if (me.isAdmin) {
        adminBtn.removeAttribute('hidden');
      } else {
        adminBtn.setAttribute('hidden', '');
      }
    }

    refreshBadge();
    render();
  } catch (err) {
    $('#view').innerHTML = `<div class="empty">ÐÑÐºÑÐ¾Ð¹ÑÐµ Ð¼Ð°Ð³Ð°Ð·Ð¸Ð½ ÑÐµÑÐµÐ· Telegram-Ð±Ð¾ÑÐ°.<br><small>${esc(err.message)}</small></div>`;
  }
})();
