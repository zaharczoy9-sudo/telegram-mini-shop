const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const byn = (n) => new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n) + ' BYN';
const r2 = (n) => Math.round(n * 100) / 100;

const S = {
  tab: 'catalog',
  me: null,
  cfg: { shopName: 'SAZY SHOP', hours: 24, maxStep: 10, fees: { listingStars: 50, listingByn: 3, bumpStars: 25 } },
  q: '',
  sort: 'bump',
  off: 0, // server time offset, ms
  mineTab: 'lots',
  adminTab: 'pending',
  poll: null,
};
const F = { title: '', size: '', start_price: '', min_step: '', city: '', contact: '', description: '', image_ids: [] };

const ICON = {
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  sort: '<svg viewBox="0 0 24 24"><path d="M8 4v16M4 16l4 4 4-4M16 20V4m-4 4l4-4 4 4"/></svg>',
  heart: '<svg viewBox="0 0 24 24"><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.5 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/></svg>',
};

const STATUS = {
  draft: ['Не оплачен', 'confirmed'],
  pending_review: ['На проверке', 'new'],
  active: ['Идёт', 'done'],
  ended: ['Завершён', 'cancelled'],
  cancelled: ['Снят', 'cancelled'],
};

// ---------- core helpers ----------
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, {
    method,
    headers: { 'X-Init-Data': tg?.initData || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Ошибка ' + r.status);
  return data;
}
function syncTime(now) { if (now) S.off = Date.parse(now) - Date.now(); }
const nowMs = () => Date.now() + S.off;

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 2400);
}
const haptic = () => tg?.HapticFeedback?.impactOccurred?.('light');

function sheet(html, onMount) {
  clearInterval(S.poll);
  const root = $('#sheetRoot');
  root.innerHTML = `<div class="shade"><div class="sheet">${html}</div></div>`;
  const shade = root.firstChild;
  shade.addEventListener('click', (e) => { if (e.target === shade) closeSheet(); });
  onMount?.(root.querySelector('.sheet'));
}
function closeSheet() {
  clearInterval(S.poll);
  $('#sheetRoot').innerHTML = '';
}
function confirmBox(text) {
  return new Promise((resolve) => {
    if (tg?.showConfirm) tg.showConfirm(text, resolve);
    else resolve(window.confirm(text));
  });
}

// ---------- time ----------
function leftText(endsAt) {
  const ms = Date.parse(endsAt) - nowMs();
  if (ms <= 0) return 'Завершён';
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return hh > 0 ? `${hh}ч ${String(mm).padStart(2, '0')}м` : `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
setInterval(() => {
  document.querySelectorAll('[data-end]').forEach((el) => {
    el.textContent = leftText(el.dataset.end);
    el.classList.toggle('urgent', Date.parse(el.dataset.end) - nowMs() < 3600 * 1000);
  });
}, 1000);

const isLive = (a) => a.status === 'active' && Date.parse(a.ends_at) > nowMs();
function timerHtml(a, cls = '') {
  if (a.status === 'active') {
    const urgent = Date.parse(a.ends_at) - nowMs() < 3600 * 1000 ? ' urgent' : '';
    return `<span class="timer ${cls}${urgent}" data-end="${esc(a.ends_at)}">${leftText(a.ends_at)}</span>`;
  }
  return `<span class="timer ${cls}">${STATUS[a.status]?.[0] || ''}</span>`;
}
function ago(d) {
  const s = Math.max(0, Math.floor((nowMs() - Date.parse(d)) / 1000));
  if (s < 60) return 'только что';
  if (s < 3600) return Math.floor(s / 60) + ' мин назад';
  if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
  return Math.floor(s / 86400) + ' дн назад';
}
function contactHtml(c) {
  const m = /^@?([A-Za-z][A-Za-z0-9_]{3,31})$/.exec(String(c).trim());
  return m ? `<a href="#" data-tg="https://t.me/${m[1]}">@${m[1]}</a>` : esc(c);
}

// ---------- list rendering ----------
let ITEMS = [];

function cardHtml(a) {
  return `<div class="card" data-id="${a.id}">
    <div class="ph" data-act="open">
      ${a.images[0] ? `<img loading="lazy" src="${a.images[0]}" alt="">` : ''}
      ${timerHtml(a, 'on-img')}
      ${a.leading ? '<span class="lead">Вы лидируете</span>' : ''}
    </div>
    <h3 data-act="open">${esc(a.title)}</h3>
    <div class="meta">${esc(a.size)} · ${esc(a.city)}</div>
    <div class="acts">
      <button class="ib heart ${a.fav ? 'on' : ''}" data-act="fav">${ICON.heart}</button>
      <div class="pcol"><span class="price">${byn(a.current_price)}</span><small>${a.bids_count ? a.bids_count + ' ' + plural(a.bids_count, ['ставка', 'ставки', 'ставок']) : 'нет ставок'}</small></div>
    </div>
  </div>`;
}
function plural(n, f) {
  const m = n % 10, c = n % 100;
  return c > 10 && c < 20 ? f[2] : m === 1 ? f[0] : m >= 2 && m <= 4 ? f[1] : f[2];
}
function rowHtml(a, extra = '') {
  const [label, cls] = STATUS[a.status] || ['', ''];
  return `<div class="item" data-id="${a.id}" data-act="open">
    <img src="${a.images[0] || ''}" alt="">
    <div class="info">
      <b>${esc(a.title)}</b>
      <small>${byn(a.current_price)}${a.bids_count ? ' · ' + a.bids_count + ' ' + plural(a.bids_count, ['ставка', 'ставки', 'ставок']) : ''}</small>
      <div style="margin-top:4px">${a.status === 'active' ? timerHtml(a) : `<span class="st ${cls}">${label}</span>`}${a.leading && a.status === 'active' ? ' <span class="st done">лидируете</span>' : ''}${a.leading && a.status === 'ended' ? ' <span class="st done">вы выиграли</span>' : ''}</div>
    </div>
    ${extra}
  </div>`;
}

async function loadList(scope, extra = {}) {
  const p = new URLSearchParams({ scope, ...extra });
  const d = await api('/auctions?' + p);
  syncTime(d.now);
  ITEMS = d.items;
  return d.items;
}
function renderGrid(list, emptyText) {
  const g = $('#grid');
  if (!g) return;
  g.innerHTML = list.length ? list.map(cardHtml).join('') : `<div class="empty" style="grid-column:1/-1">${emptyText}</div>`;
}

async function viewCatalog() {
  $('#top').innerHTML = `
    <div class="header-row">
      <div class="logo">${S.cfg.avatar ? '<img src="/avatar.jpg" alt="" onerror="this.remove()">' : ''}${esc((S.cfg.shopName || 'S')[0])}</div>
      <h1 class="title">${esc(S.cfg.shopName)}</h1>
    </div>
    <div class="row">
      <label class="search">${ICON.search}<input id="q" placeholder="Найти лот..." value="${esc(S.q)}"></label>
      <button class="sqbtn" id="sortBtn">${ICON.sort}</button>
    </div>`;
  $('#view').innerHTML = '<div class="grid" id="grid"></div>';
  const load = async () => renderGrid(await loadList('all', { q: S.q, sort: S.sort }), 'Активных аукционов пока нет');
  let timer;
  $('#q').addEventListener('input', (e) => {
    S.q = e.target.value.trim();
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  });
  $('#sortBtn').onclick = () => {
    const opts = [['bump', 'Сначала поднятые'], ['ending', 'Скоро закончатся'], ['new', 'Новые'], ['price_asc', 'Сначала дешёвые'], ['price_desc', 'Сначала дорогие']];
    sheet(`<h2>Сортировка</h2>${opts.map(([k, l]) => `<button class="opt ${S.sort === k ? 'on' : ''}" data-sort="${k}">${l}</button>`).join('')}`, (el) =>
      el.querySelectorAll('[data-sort]').forEach((b) => (b.onclick = () => { S.sort = b.dataset.sort; closeSheet(); load(); })));
  };
  await load();
}

async function viewFavs() {
  $('#top').innerHTML = '<h1 class="title">Избранное</h1>';
  $('#view').innerHTML = '<div class="grid" id="grid"></div>';
  renderGrid(await loadList('fav'), 'Здесь пока пусто.<br>Нажмите ♡ на понравившемся лоте');
}

async function viewMine() {
  $('#top').innerHTML = '<h1 class="title">Мои торги</h1>';
  const scope = S.mineTab === 'lots' ? 'mine' : 'bidding';
  const items = await loadList(scope);
  $('#view').innerHTML = `
    <div class="tabs">
      <button data-mt="lots" class="${S.mineTab === 'lots' ? 'on' : ''}">Мои лоты</button>
      <button data-mt="bids" class="${S.mineTab === 'bids' ? 'on' : ''}">Мои ставки</button>
    </div>
    <div class="list">${items.length ? items.map((a) => rowHtml(a)).join('') : `<div class="empty">${S.mineTab === 'lots' ? 'Вы ещё не выставляли лоты.<br>Нажмите «Выставить» внизу.' : 'Вы ещё не делали ставок'}</div>`}</div>`;
  $('#view').querySelectorAll('[data-mt]').forEach((b) => (b.onclick = () => { S.mineTab = b.dataset.mt; viewMine(); }));
}

// ---------- delegated clicks ----------
document.addEventListener('click', async (e) => {
  const tgLink = e.target.closest('[data-tg]');
  if (tgLink) {
    e.preventDefault();
    if (tg?.openTelegramLink) tg.openTelegramLink(tgLink.dataset.tg);
    else window.open(tgLink.dataset.tg, '_blank');
    return;
  }
  const act = e.target.closest('[data-act]');
  const holder = e.target.closest('[data-id]');
  if (!act || !holder) return;
  const id = Number(holder.dataset.id);
  try {
    if (act.dataset.act === 'open') return openLot(id);
    if (act.dataset.act === 'fav') {
      const a = ITEMS.find((x) => x.id === id);
      if (!a) return;
      await api('/favorites/' + id, a.fav ? 'DELETE' : 'POST');
      a.fav = !a.fav;
      haptic();
      if (S.tab === 'favs' && !a.fav) holder.remove();
      else act.classList.toggle('on', a.fav);
    }
  } catch (err) {
    toast(err.message);
  }
});

// ---------- lot sheet ----------
async function openLot(id) {
  const data = await api('/auctions/' + id);
  syncTime(data.now);
  const a0 = data.item;
  sheet(
    `${a0.images.length ? `<div class="gallery">${a0.images.map((i) => `<img src="${i}" alt="">`).join('')}</div>` : ''}
     <h2>${esc(a0.title)}</h2>
     <div class="box kv">
       <div><span>Размер</span><b>${esc(a0.size)}</b></div>
       <div><span>Личная встреча</span><b>${esc(a0.city)}</b></div>
       <div><span>Контакт владельца</span><b>${contactHtml(a0.contact)}</b></div>
       <div><span>Старт</span><b>${byn(a0.start_price)}</b></div>
       <div><span>Шаг ставки</span><b>${byn(a0.min_step)} – ${byn(a0.max_step)}</b></div>
     </div>
     ${a0.description ? `<p class="desc">${esc(a0.description)}</p>` : ''}
     <div id="lotDyn"></div>`,
    (el) => {
      let state = data;
      const dyn = el.querySelector('#lotDyn');
      const draw = () => drawLotDyn(dyn, state, async () => {
        const d = await api('/auctions/' + id);
        syncTime(d.now);
        state = d;
        draw();
      });
      draw();
      S.poll = setInterval(async () => {
        try {
          const d = await api('/auctions/' + id);
          syncTime(d.now);
          state = d;
          draw();
        } catch {}
      }, 6000);
    }
  );
}

function bidRange(a) {
  const first = a.bids_count === 0;
  const lo = first ? a.start_price : r2(a.current_price + a.min_step);
  const hi = r2((first ? a.start_price : a.current_price) + a.max_step);
  return { lo, hi, first };
}

function drawLotDyn(dyn, state, refresh) {
  const a = state.item;
  const bids = state.bids;
  const live = isLive(a);
  const keep = dyn.querySelector('#bidAmt');
  const saved = keep ? { v: keep.value, f: document.activeElement === keep } : null;

  let controls = '';
  if (live && !a.mine) {
    if (a.leading) {
      controls = '<div class="box ok-box">🎉 Ваша ставка лидирует. Если вас перебьют, мы пришлём уведомление.</div>';
    } else {
      const { lo, hi, first } = bidRange(a);
      const steps = [...new Set([a.min_step, 5, a.max_step].filter((s) => s >= a.min_step && s <= a.max_step).map(r2))];
      const chips = first ? [lo] : steps.map((s) => r2(a.current_price + s));
      controls = `<div class="box">
        <h4>Ваша ставка</h4>
        <div class="muted">От ${byn(lo)} до ${byn(hi)}</div>
        <div class="chips" style="padding-top:10px">${chips.map((v) => `<button class="chip" data-amt="${v}">${byn(v)}</button>`).join('')}</div>
        <div class="row" style="margin-top:8px">
          <input class="f" id="bidAmt" type="number" step="0.01" inputmode="decimal" placeholder="${lo}" value="${lo}">
          <button class="btn sm" id="bidBtn" style="white-space:nowrap">Поставить</button>
        </div>
      </div>`;
    }
  }

  let owner = '';
  if (a.mine) {
    if (a.status === 'draft' || a.status === 'pending_review') {
      owner = `<div class="box">
        <b>${a.status === 'draft' ? 'Лот не опубликован' : 'Оплата на проверке'}</b>
        <div class="muted" style="margin:4px 0 10px">${a.status === 'draft' ? 'Оплатите размещение, чтобы запустить торги.' : 'Администратор проверит перевод. Можно оплатить звёздами и не ждать.'}</div>
        <button class="btn" id="payBtn">Оплатить и опубликовать</button>
        <button class="btn danger" id="delBtn" style="margin-top:8px">Удалить лот</button>
      </div>`;
    } else if (live) {
      owner = `<div class="box">
        <button class="btn" id="bumpBtn">🔝 Поднять за ${S.cfg.fees.bumpStars} ⭐</button>
        ${a.bids_count === 0 ? '<button class="btn danger" id="delBtn" style="margin-top:8px">Снять с торгов</button>' : '<div class="muted" style="margin-top:8px">Лот со ставками снять нельзя.</div>'}
      </div>`;
    }
  } else if (S.me?.isAdmin && a.status !== 'cancelled') {
    owner = '<div class="box"><button class="btn danger" id="delBtn">Снять лот (админ)</button></div>';
  }

  const ended = !live && ['active', 'ended'].includes(a.status);
  const resultBox = ended
    ? a.bids_count
      ? `<div class="box ok-box">🏁 Торги завершены. ${a.leading ? 'Вы победили! Контакт и город — выше.' : `Победитель: ${esc(a.leader_name)}`}</div>`
      : '<div class="box">Торги завершены без ставок.</div>'
    : '';

  dyn.innerHTML = `
    <div class="box">
      <div class="row" style="justify-content:space-between">
        <div><div class="muted">${a.bids_count ? 'Текущая цена' : 'Стартовая цена'}</div><div class="bigprice">${byn(a.current_price)}</div></div>
        <div style="text-align:right"><div class="muted">${a.status === 'active' ? 'Осталось' : 'Статус'}</div>${timerHtml(a, 'big')}</div>
      </div>
      ${a.bids_count ? `<div class="muted" style="margin-top:6px">Лидер: ${esc(a.leader_name)} · ${a.bids_count} ${plural(a.bids_count, ['ставка', 'ставки', 'ставок'])}</div>` : ''}
    </div>
    ${resultBox}${controls}${owner}
    ${bids.length ? `<div class="box"><h4>История ставок</h4>${bids.map((b) => `<div class="row" style="justify-content:space-between;padding:4px 0"><span>${esc(b.user_name)} <small class="muted">${ago(b.created_at)}</small></span><b>${byn(b.amount)}</b></div>`).join('')}</div>` : ''}`;

  const input = dyn.querySelector('#bidAmt');
  if (input && saved) {
    input.value = saved.v;
    if (saved.f) input.focus();
  }
  dyn.querySelectorAll('[data-amt]').forEach((b) => (b.onclick = () => { input.value = b.dataset.amt; }));
  dyn.querySelector('#bidBtn')?.addEventListener('click', async (ev) => {
    const amount = Number(String(input.value).replace(',', '.'));
    if (!(amount > 0)) return toast('Введите сумму');
    if (!(await confirmBox(`Поставить ${byn(amount)}?`))) return;
    ev.target.disabled = true;
    try {
      await api(`/auctions/${a.id}/bid`, 'POST', { amount });
      tg?.HapticFeedback?.notificationOccurred?.('success');
      toast('Ставка принята');
      await refresh();
    } catch (err) {
      toast(err.message);
      ev.target.disabled = false;
      refresh().catch(() => {});
    }
  });
  dyn.querySelector('#payBtn')?.addEventListener('click', () => paySheet(a));
  dyn.querySelector('#bumpBtn')?.addEventListener('click', () => payStars(`/auctions/${a.id}/bump`, 'Лот поднят в начало списка'));
  dyn.querySelector('#delBtn')?.addEventListener('click', async () => {
    if (!(await confirmBox(a.mine ? 'Удалить лот?' : 'Снять лот с торгов?'))) return;
    try {
      await api('/auctions/' + a.id, 'DELETE');
      closeSheet();
      toast('Готово');
      render();
    } catch (err) {
      toast(err.message);
    }
  });
}

// ---------- payments ----------
function payStars(path, okText) {
  return api(path, 'POST').then(({ link }) => {
    if (!tg?.openInvoice) return toast('Оплата звёздами работает только внутри Telegram');
    tg.openInvoice(link, (status) => {
      if (status === 'paid') {
        toast(okText);
        closeSheet();
        S.tab = 'mine';
        S.mineTab = 'lots';
        setTimeout(render, 1800);
      } else if (status === 'failed') toast('Платёж не прошёл');
    });
  }).catch((err) => toast(err.message));
}

function paySheet(a) {
  const f = S.cfg.fees;
  sheet(
    `<h2>Размещение лота №${a.id}</h2>
     <p class="muted" style="margin:0 0 14px">Аукцион длится ${S.cfg.hours} ч с момента публикации.</p>
     <button class="btn" id="pStars">Оплатить ${f.listingStars} ⭐ — сразу</button>
     <button class="btn sec" id="pByn" style="margin-top:8px">Оплатить ${byn(f.listingByn)} переводом</button>
     ${S.me?.isAdmin ? '<button class="btn sec" id="pFree" style="margin-top:8px">Опубликовать бесплатно (админ)</button>' : ''}
     <button class="btn sec" id="pLater" style="margin-top:8px">Позже</button>`,
    (el) => {
      el.querySelector('#pStars').onclick = () => payStars(`/auctions/${a.id}/pay/stars`, 'Оплачено! Лот публикуется…');
      el.querySelector('#pLater').onclick = () => { closeSheet(); S.tab = 'mine'; S.mineTab = 'lots'; render(); };
      el.querySelector('#pFree')?.addEventListener('click', async () => {
        try { await api(`/auctions/${a.id}/publish-free`, 'POST'); closeSheet(); toast('Опубликовано'); S.tab = 'mine'; render(); } catch (err) { toast(err.message); }
      });
      el.querySelector('#pByn').onclick = () => {
        sheet(
          `<h2>Перевод ${byn(f.listingByn)}</h2>
           <div class="box" style="white-space:pre-wrap">${esc(S.me?.payInfo || '')}</div>
           <p class="muted">В комментарии к переводу укажите: <b>лот №${a.id}</b>.<br>После перевода нажмите кнопку ниже — администратор подтвердит оплату и лот появится в аукционе.</p>
           <button class="btn" id="paid">Я оплатил(а)</button>
           <button class="btn sec" id="back" style="margin-top:8px">Назад</button>`,
          (el2) => {
            el2.querySelector('#back').onclick = () => paySheet(a);
            el2.querySelector('#paid').onclick = async (ev) => {
              ev.target.disabled = true;
              try {
                await api(`/auctions/${a.id}/pay/byn`, 'POST');
                closeSheet();
                toast('Отправлено на проверку');
                S.tab = 'mine';
                S.mineTab = 'lots';
                render();
              } catch (err) {
                toast(err.message);
                ev.target.disabled = false;
              }
            };
          }
        );
      };
    }
  );
}

// ---------- create lot ----------
async function resizeImage(file) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, 1200 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
}
async function uploadImage(file) {
  const blob = await resizeImage(file);
  const r = await fetch('/api/upload', {
    method: 'POST',
    headers: { 'X-Init-Data': tg?.initData || '', 'Content-Type': 'image/jpeg' },
    body: blob,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Не удалось загрузить фото');
  return d.id;
}

function viewCreate() {
  $('#top').innerHTML = '<h1 class="title">Выставить лот</h1>';
  if (!F.contact && S.me?.username) F.contact = '@' + S.me.username;
  const f = S.cfg.fees;
  const v = $('#view');
  v.innerHTML = `
    <div class="box info-box">
      Аукцион длится <b>${S.cfg.hours} ч</b>. ${S.cfg.freeListing ? 'Размещение <b>бесплатно</b> (акция к открытию).' : `Размещение: <b>${f.listingStars} ⭐</b> или <b>${byn(f.listingByn)}</b>.`}
      Поднять лот в начало списка — <b>${f.bumpStars} ⭐</b>.
    </div>
    <div class="box">
      <label style="margin-top:0">Фото (до 10)</label>
      <div class="thumbs" id="thumbs"></div>
      <input type="file" id="ff" accept="image/*" multiple hidden>
      <label>Название</label><input class="f" id="ft" maxlength="100" placeholder="Например: Куртка Stone Island" value="${esc(F.title)}">
      <div class="row">
        <div style="flex:1"><label>Размер</label><input class="f" id="fz" maxlength="30" placeholder="M / 48 / 42" value="${esc(F.size)}"></div>
        <div style="flex:1"><label>Город встречи</label><input class="f" id="fc" maxlength="60" placeholder="Минск" value="${esc(F.city)}"></div>
      </div>
      <div class="row">
        <div style="flex:1"><label>Старт. цена, BYN</label><input class="f" id="fp" type="number" step="0.01" inputmode="decimal" value="${esc(F.start_price)}"></div>
        <div style="flex:1"><label>Мин. шаг, BYN</label><input class="f" id="fs" type="number" step="0.01" inputmode="decimal" value="${esc(F.min_step)}"></div>
      </div>
      <div class="muted" style="margin:6px 2px 0">Максимальный шаг ставки — ${byn(S.cfg.maxStep)} (фиксированный).</div>
      <label>Ваш контакт для связи</label><input class="f" id="fk" maxlength="80" placeholder="@username или телефон" value="${esc(F.contact)}">
      <label>Описание</label><textarea class="f" id="fd" maxlength="3000" placeholder="Состояние, дефекты, замеры...">${esc(F.description)}</textarea>
    </div>
    <button class="btn" id="go">Продолжить</button>`;

  const bind = (id, key) => v.querySelector(id).addEventListener('input', (e) => (F[key] = e.target.value));
  bind('#ft', 'title'); bind('#fz', 'size'); bind('#fc', 'city'); bind('#fp', 'start_price');
  bind('#fs', 'min_step'); bind('#fk', 'contact'); bind('#fd', 'description');

  const draw = () => {
    v.querySelector('#thumbs').innerHTML =
      F.image_ids.map((id, i) => `<div class="th"><img src="/img/${id}"><button class="x" data-i="${i}">×</button></div>`).join('') +
      (F.image_ids.length < 10 ? '<label class="addimg" for="ff">+</label>' : '');
    v.querySelectorAll('.thumbs .x').forEach((b) => (b.onclick = () => { F.image_ids.splice(Number(b.dataset.i), 1); draw(); }));
  };
  draw();
  v.querySelector('#ff').onchange = async (e) => {
    toast('Загружаю фото...');
    try {
      for (const file of e.target.files) {
        if (F.image_ids.length >= 10) break;
        F.image_ids.push(await uploadImage(file));
      }
      draw();
    } catch (err) {
      toast(err.message);
    }
    e.target.value = '';
  };
  v.querySelector('#go').onclick = async (e) => {
    if (!F.image_ids.length) return toast('Добавьте хотя бы одно фото');
    e.target.disabled = true;
    try {
      const { id, published } = await api('/auctions', 'POST', F);
      const title = F.title;
      Object.assign(F, { title: '', size: '', start_price: '', min_step: '', city: '', description: '', image_ids: [] });
      if (published) {
        toast('Лот опубликован!');
        tg?.HapticFeedback?.notificationOccurred?.('success');
        S.tab = 'mine';
        S.mineTab = 'lots';
        render();
        return;
      }
      paySheet({ id, title });
      viewCreate();
    } catch (err) {
      toast(err.message);
    }
    e.target.disabled = false;
  };
}

// ---------- admin ----------
async function viewAdmin() {
  $('#top').innerHTML = '<h1 class="title">Админ-панель</h1>';
  const status = S.adminTab === 'pending' ? 'pending_review' : '';
  const d = await api('/admin/auctions' + (status ? '?status=' + status : ''));
  syncTime(d.now);
  ITEMS = d.items;
  const v = $('#view');
  v.innerHTML = `
    <div class="tabs">
      <button data-at="pending" class="${S.adminTab === 'pending' ? 'on' : ''}">Оплаты BYN</button>
      <button data-at="all" class="${S.adminTab === 'all' ? 'on' : ''}">Все лоты</button>
    </div>
    <div class="list">${
      d.items.length
        ? d.items.map((a) => `<div class="box" data-id="${a.id}" style="padding:12px">
            ${rowHtml(a).replace('class="item"', 'class="item" style="box-shadow:none;padding:0"')}
            <div class="muted" style="margin:8px 0">Продавец: ${esc(a.seller_name)} (id ${a.seller_id}) · ${esc(a.contact)}</div>
            ${a.status === 'pending_review'
              ? `<div class="row"><button class="btn sm" data-adm="approve">Подтвердить оплату</button><button class="btn sm danger" data-adm="reject">Отклонить</button></div>`
              : a.status !== 'cancelled' ? '<button class="btn sm danger" data-adm="del">Снять лот</button>' : ''}
          </div>`).join('')
        : `<div class="empty">${S.adminTab === 'pending' ? 'Нет оплат на проверке' : 'Лотов нет'}</div>`
    }</div>`;
  v.querySelectorAll('[data-at]').forEach((b) => (b.onclick = () => { S.adminTab = b.dataset.at; viewAdmin(); }));
  v.querySelectorAll('[data-adm]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    const id = b.closest('[data-id]').dataset.id;
    const kind = b.dataset.adm;
    if (kind === 'del' && !(await confirmBox('Снять лот?'))) return;
    try {
      if (kind === 'del') await api('/auctions/' + id, 'DELETE');
      else await api(`/admin/auctions/${id}/${kind}`, 'POST');
      viewAdmin();
    } catch (err) {
      toast(err.message);
    }
  }));
}

// ---------- router ----------
async function render() {
  document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
  window.scrollTo(0, 0);
  try {
    if (S.tab === 'catalog') await viewCatalog();
    else if (S.tab === 'favs') await viewFavs();
    else if (S.tab === 'create') viewCreate();
    else if (S.tab === 'mine') await viewMine();
    else if (S.tab === 'admin' && S.me?.isAdmin) await viewAdmin();
    else { S.tab = 'catalog'; await viewCatalog(); }
  } catch (err) {
    $('#view').innerHTML = `<div class="empty">${esc(err.message)}</div>`;
  }
}

document.querySelectorAll('#nav button').forEach((b) => (b.onclick = () => {
  S.tab = b.dataset.tab;
  closeSheet();
  render();
}));

(async function init() {
  try {
    const [cfg, me] = await Promise.all([fetch('/api/config').then((r) => r.json()), api('/me')]);
    S.cfg = cfg;
    S.me = me;
    document.title = cfg.shopName;
    $('#nav button[data-tab="admin"]').hidden = !me.isAdmin;
    render();
  } catch (err) {
    $('#view').innerHTML = `<div class="empty">Откройте аукцион через Telegram-бота.<br><small>${esc(err.message)}</small></div>`;
  }
})();
