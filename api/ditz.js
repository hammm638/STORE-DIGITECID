const crypto = require('crypto');
const BASE = 'https://www.ditznesia.com/api/dev/';
const KEY = () => 'ae4674b4b4b9d22a91d8c2615a976ceb';
const MARKUP = () => Number(process.env.DITZ_MARKUP || 0);
const RURL = () => 'https://striking-macaque-209704.upstash.io';
const RTOK = () => 'gQAAAAAAAzMoAAIgcDIzOWE4YzMwMzhmMWQ0MDczOTJmZjdkYWJhMGZkMjFhNA';
const READ = new Set(['countries', 'services', 'operators', 'otpwa-services', 'shopee-countries', 'tg-countries']);
const REFUND = new Set(['canceled', 'cancelled', 'expired', 'failed', 'refunded', 'timeout', 'batal', 'kadaluarsa']);
const kEmail = (e) => String(e || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
const mask = (u) => { const s = String(u || ''); return s.slice(0, 2) + '***' + s.slice(-1); };
const sell = (p) => Math.round(Number(p || 0) * (1 + MARKUP() / 100));

class HttpErr extends Error { constructor(code, detail) { super(detail); this.code = code; } }

async function R(...cmd) {
  if (!RURL() || !RTOK()) throw new HttpErr(500, 'Database saldo belum diisi (UPSTASH_URL / UPSTASH_TOKEN)');
  const r = await fetch(RURL(), { method: 'POST', headers: { Authorization: 'Bearer ' + RTOK() }, body: JSON.stringify(cmd) });
  const j = await r.json();
  if (j.error) throw new HttpErr(500, 'Database error');
  return j.result;
}

async function ditz(path, params) {
  const p = new URLSearchParams(params || {});
  p.set('apikey', KEY());
  const r = await fetch(BASE + path + '?' + p.toString());
  const t = await r.text();
  let d; try { d = JSON.parse(t); } catch (e) { d = { detail: 'Respons API tidak valid' }; }
  if (!r.ok || (d && !Array.isArray(d) && d.detail)) throw new HttpErr(r.ok ? 400 : r.status, (d && d.detail) || ('HTTP ' + r.status));
  return d;
}

const feedPush = async (k, u, x) => { try { await R('LPUSH', 'feed', JSON.stringify({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), k, u: mask(u), x, t: Date.now() })); await R('LTRIM', 'feed', 0, 49); } catch (e) { /* feed tidak boleh menggagalkan order */ } };
const bal = async (u) => Number(await R('GET', 'bal:' + u)) || 0;
const credit = (u, n) => R('INCRBY', 'bal:' + u, Math.round(n));

/* ---- Pembayaran: buang link penyedia, buat QR di server ---- */
const HIDE = ['snap_token', 'payment_url', 'redirect_url', 'token'];
const isUrl = (v) => typeof v === 'string' && /^(https?:)?\/\//i.test(v.trim());
const isMidtrans = (v) => { try { return /(^|\.)midtrans\.com$/i.test(new URL(String(v).trim()).hostname); } catch (e) { return false; } };
// Buang snap_token & URL penyedia; pay_url hanya lolos jika milik midtrans.com (halaman pembayaran QRIS)
function clean(d) {
  const o = { ...d };
  const pay = isMidtrans(o.pay_url) ? String(o.pay_url).trim() : '';
  HIDE.forEach((k) => delete o[k]);
  delete o.pay_url;
  Object.keys(o).forEach((k) => { if (isUrl(o[k])) delete o[k]; });
  if (pay) o.pay_url = pay;
  return o;
}
// Kalau penyedia memberi qr_link berupa URL: unduh di server, kirim ke browser sebagai data gambar
async function inlineQr(d) {
  const o = { ...d };
  if (isUrl(o.qr_link)) {
    try {
      const ir = await fetch(o.qr_link.trim().replace(/^\/\//, 'https://'));
      const ct = (ir.headers.get('content-type') || '').split(';')[0];
      if (ir.ok && /^image\//i.test(ct)) o.qr_link = 'data:' + ct + ';base64,' + Buffer.from(await ir.arrayBuffer()).toString('base64');
      else o.qr_link = null;
    } catch (e) { o.qr_link = null; }
  }
  return o;
}


/* ---- QR lewat screenshot (Site-Shot): buka halaman bayar di server, pilih QRIS, ambil gambar QR saja ---- */
const SHOT_KEY = () => process.env.SITESHOT_KEY || '3BYBWIJ3SJ4VB5QIFQQRO7TJ2M';
// Skrip ini dijalankan di dalam halaman pembayaran oleh Site-Shot (javascript_code)
const QR_JS = `(function(){
  var n=0,lastClick=0;
  function T(e){return (e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim()}
  function hasQr(){
    return [].slice.call(document.querySelectorAll('img,canvas,svg')).some(function(e){
      var r=e.getBoundingClientRect();
      return r.width>=120&&r.height>=120&&Math.abs(r.width-r.height)<10&&!/logo|icon/i.test((e.getAttribute('class')||'')+(e.getAttribute('alt')||'')+(e.getAttribute('src')||''));
    });
  }
  function clickQris(){
    var all=[].slice.call(document.querySelectorAll('a,button,li,div,span,p')).filter(function(e){var t=T(e);return t&&t.length<45&&/qris/i.test(t)});
    all.sort(function(a,b){return T(a).length-T(b).length});
    var el=all[0];if(!el)return;
    var tg=el.closest('a,button,[role=button],li,[class*=item],[class*=list]')||el;
    try{tg.click()}catch(e){}
  }
  var t=setInterval(function(){
    if(++n>20||hasQr()){clearInterval(t);return}
    if(Date.now()-lastClick>2500){lastClick=Date.now();clickQris()}
  },400);
})();`;

async function shotQr(id) {
  const cached = await R('GET', 'qrimg:' + id);
  if (cached) return JSON.parse(cached);
  const pay = await R('GET', 'pay:' + id);
  if (!pay || !isMidtrans(pay)) return { qr_err: 'Halaman pembayaran tidak tersedia' };
  if (!SHOT_KEY()) return { qr_err: 'SITESHOT_KEY belum diisi' };
  if ((await R('SET', 'qrlock:' + id, '1', 'NX', 'EX', 90)) !== 'OK') return { qr_pending: true };   // sedang dibuat oleh permintaan lain
  let out = {};
  const keys = await shotKeys();
  const st = (await R('INCR', 'shotrr')) % keys.length;
  for (let a = 0; a < Math.min(keys.length, 5); a++) {
  out = {};
  const KEYNOW = keys[(st + a) % keys.length];
  try {
    const p = new URLSearchParams({
      url: pay, userkey: KEYNOW, width: '420', height: '620', format: 'png', response_type: 'json',
      delay_time: '9000', timeout: '50000', fresh_session: '1', javascript_code: QR_JS,
    });
    const r = await fetch('https://api.site-shot.com/?' + p.toString());
    const t = await r.text();
    let j = {}; try { j = JSON.parse(t); } catch (e) { /* bukan JSON */ }
    const im = String(j.image || '');
    if (r.status === 429) { out.qr_err = 'Screenshot ditolak (429): kuota atau batas permintaan Site-Shot tercapai. ' + String(j.error || t || '').replace(/\s+/g, ' ').slice(0, 100); out.wait = 120; }
    else if (j.error || !im) out.qr_err = 'Screenshot: ' + String(j.error || ('HTTP ' + r.status)).slice(0, 100);
    else { out.qr_link = im.startsWith('data:') ? im : 'data:image/png;base64,' + im; out.shot = true; }   // shot: gambar 420x620, dipotong di sisi halaman
  } catch (e) { out.qr_err = 'Gagal mengambil screenshot'; }
  if (out.qr_link || !out.wait) break;   // lanjut ke key berikutnya hanya jika kena 429
  }
  await R('SET', 'qrimg:' + id, JSON.stringify(out), 'EX', out.qr_link ? 3600 : (out.wait || 30));   // gagal: coba lagi setelah 30 detik (429: 2 menit)
  delete out.wait;
  await R('DEL', 'qrlock:' + id);
  return out;
}

async function shotKeys() {
  try { const l = JSON.parse((await R('GET', 'shotkeys')) || '[]'); if (Array.isArray(l) && l.length) return l; } catch (e) { /* pakai bawaan */ }
  return [SHOT_KEY()];
}
const ADMIN = () => process.env.ADMIN_EMAIL || 'ilhamkholif123123@gmail.com';

function pick(b) {
  const server = String(b.server || ''), country = String(b.country || ''), produk = String(b.produk || ''), provider = b.provider === undefined || b.provider === null ? '' : String(b.provider);
  if (!/^[1-6]$/.test(server) || !/^[A-Za-z0-9]{1,8}$/.test(country) || !/^[\w.\-]{1,40}$/.test(produk) || !/^[\w.\-]{0,40}$/.test(provider)) throw new HttpErr(400, 'Pilihan layanan tidak valid');
  return { server, country, produk, provider };
}
async function quote(b) {
  const o = pick(b);
  const list = await ditz('services', { server: o.server, country: o.country, service: o.produk });
  const item = (Array.isArray(list) ? list : []).find((x) => (String(x.id) === o.produk || String(x.produk) === o.produk) && (!o.provider || String(x.provider) === o.provider));
  if (!item) throw new HttpErr(400, 'Layanan tidak tersedia / stok habis');
  return { o, price: sell(item.price) };
}
async function ownOrder(u, id) {
  if (!/^[\w\-]{8,64}$/.test(String(id || ''))) throw new HttpErr(400, 'ID order tidak valid');
  const rec = JSON.parse((await R('GET', 'ord:' + id)) || 'null');
  if (!rec || rec.u !== u) throw new HttpErr(404, 'Order tidak ditemukan');
  return rec;
}

/* ---- Statistik harian per user (grafik dashboard) ---- */
const dayWIB = (t) => new Date(Number(t) + 25200000).toISOString().slice(0, 10);
async function userStat(u, kind, amt) {   // kind: 'o' = order, 'dp' = deposit berhasil
  try {
    const k = 'ust:' + u + ':' + dayWIB(Date.now());
    await R('HINCRBY', k, kind, 1);
    await R('HINCRBY', k, kind + 's', Math.round(Number(amt) || 0));
    await R('EXPIRE', k, 7776000);
    const g = 'gst:' + dayWIB(Date.now());
    await R('HINCRBY', g, kind, 1);
    await R('HINCRBY', g, kind + 's', Math.round(Number(amt) || 0));
    await R('EXPIRE', g, 7776000);
  } catch (e) { /* statistik tidak boleh menggagalkan transaksi */ }
}

/* ---- Indeks profil ringan (tanpa foto) supaya daftar user cepat ---- */
async function lightProfiles() {
  const [a, b] = await Promise.all([R('HLEN', 'prof'), R('HLEN', 'pidx')]);
  if ((Number(a) || 0) > (Number(b) || 0)) {   // isi indeks sekali dari data lama (foto tidak ikut disalin)
    let cur = '0', guard = 0;
    do {
      const r = (await R('HSCAN', 'prof', cur, 'COUNT', 100)) || ['0', []];
      cur = String(r[0]); const arr = r[1] || [], args = [];
      for (let i = 0; i + 1 < arr.length; i += 2) {
        try { const o = JSON.parse(arr[i + 1]); if (o && o.u) args.push(arr[i], JSON.stringify({ u: o.u, e: o.e || '', s: o.s || 0 })); } catch (e) { /* lewati */ }
      }
      if (args.length) await R('HSET', 'pidx', ...args);
    } while (cur !== '0' && ++guard < 400);
  }
  return (await R('HGETALL', 'pidx')) || [];
}

/* ---- Rekap feed ke hitungan harian (evd:), dipakai grafik admin dan grafik toko ---- */
async function ingestFeed() {
  const items = ((await R('LRANGE', 'feed', 0, 49)) || []).map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter((x) => x && x.id && x.t);
  const fresh = await Promise.all(items.map((x) => R('SET', 'evs:' + x.id, '1', 'NX', 'EX', 604800)));
  for (let i = 0; i < items.length; i++) {
    if (fresh[i] !== 'OK') continue;
    const x = items[i], k = 'evd:' + dayWIB(x.t), m = String(x.x || '').match(/Rp ([\d.,]+)/);
    await R('HINCRBY', k, String(x.k || 'lain').slice(0, 12), 1);
    if (x.k === 'deposit' && m) await R('HINCRBY', k, 'sum', parseInt(m[1].replace(/[^\d]/g, ''), 10) || 0);
    await R('EXPIRE', k, 7776000);
  }
}

async function refundOnce(u, id, price) { if ((await R('SETNX', 'ref:' + id, '1')) === 1) await credit(u, price); }
async function ownDep(u, id) {
  if (!/^[\w\-]{3,64}$/.test(String(id || '')) || (await R('GET', 'dep:' + id)) !== u) throw new HttpErr(404, 'Deposit tidak ditemukan');
}
async function checkDep(u, id) {
  const d = await ditz('deposit/status', { id });
  if (d.status === 'berhasil' && (await R('SETNX', 'cred:' + id, '1')) === 1) { await credit(u, d.total_diterima || d.nominal); await feedPush('deposit', u, 'deposit berhasil Rp ' + Number(d.nominal || 0).toLocaleString('id-ID')); await userStat(u, 'dp', d.nominal); }
  return d;
}

const auditLog = async (text) => {
  const t = String(text || '').trim().slice(0, 200);
  if (!t) throw new HttpErr(400, 'Isi catatan');
  await R('LPUSH', 'audit', JSON.stringify({ text: t, t: Date.now() }));
  await R('LTRIM', 'audit', 0, 199);
};

/* ---- Refund otomatis terjadwal (dipanggil Vercel Cron): cek semua order yang masih tertunda ---- */
async function cronRefund() {
  if ((await R('SETNX', 'pend_init', '1')) === 1) {   // sekali: masukkan order lama (masih ada di server) ke daftar tertunda
    let cur = '0', guard = 0;
    do {
      const r = (await R('SCAN', cur, 'MATCH', 'ord:*', 'COUNT', 500)) || ['0', []];
      cur = String(r[0]);
      const ks = (r[1] || []).map((k) => String(k).slice(4));
      if (ks.length) await R('SADD', 'pend', ...ks);
    } while (cur !== '0' && ++guard < 200);
  }
  const ids = ((await R('SMEMBERS', 'pend')) || []).slice(0, 80);
  let refunded = 0, cleaned = 0;
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(ids.slice(i, i + 10).map(async (id) => {
      try {
        if (await R('GET', 'ref:' + id)) { await R('SREM', 'pend', id); cleaned++; return; }
        const rec = JSON.parse((await R('GET', 'ord:' + id)) || 'null');
        if (!rec) { await R('SREM', 'pend', id); cleaned++; return; }
        const d = await ditz('status', { id });
        if (REFUND.has(String(d.status).toLowerCase())) {
          if ((await R('SETNX', 'ref:' + id, '1')) === 1) {
            await credit(rec.u, rec.price); refunded++;
            await feedPush('cancel', rec.u, 'order batal/gagal, saldo dikembalikan otomatis');
          }
          await R('SREM', 'pend', id); cleaned++;
        } else if (d.otp && String(d.otp).toLowerCase() !== 'waiting') { await R('SREM', 'pend', id); cleaned++; }
      } catch (e) { /* dicek lagi di jadwal berikutnya */ }
    }));
  }
  return { checked: ids.length, refunded, cleaned };
}


/* ---- Layanan tambahan: OTP WhatsApp, Shopee siap pakai, Telegram/WhatsApp siap pakai ----
   Kunci Redis baru (tidak menyentuh data lama): xo:<id> data order, xords:<user> daftar order, xpend set order tertunda. */
function makeExt(h) {
  const { R, ditz, sell, bal, credit, refundOnce, feedPush, fail, REFUND } = h;
  const KINDS = { wa: 'OTP WhatsApp', sp: 'Shopee Siap Pakai', tg: 'Telegram Siap Pakai', tw: 'WhatsApp Siap Pakai' };
  const PATHS = { 'otpwa-services': 'wa', 'shopee-countries': 'sp', 'tg-countries': 'tg' };
  const REASONS = ['registered', 'no_wa_option', 'changed_mind'];
  const low = (v) => String(v == null ? '' : v).toLowerCase();
  const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const rows = (d, k) => { const a = Array.isArray(d) ? d : (d && (d[k] || d.data || d.items || d.result)); return Array.isArray(a) ? a : []; };
  const pick = (o, ks) => { for (const k of ks) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
  const stockOf = (x) => { const v = pick(x, ['stock', 'stok', 'count', 'available', 'qty']); return num(v); };
  const scrub = (d) => { const o = {}; Object.keys(d || {}).forEach((k) => { if (!/api_?key/i.test(k) && k !== 'price') o[k] = d[k]; }); return o; };

  const kindOf = (k) => { if (!KINDS[k]) throw fail(400, 'invalid_param', 'Jenis layanan tidak valid'); return k; };
  const readyKind = (app) => {
    const a = low(app || 'telegram');
    if (a === 'telegram') return 'tg';
    if (a === 'whatsapp') return 'tw';
    throw fail(400, 'invalid_param', 'app harus telegram atau whatsapp');
  };
  const kindOfPath = (path, app) => (path === 'tg-countries' ? readyKind(app) : PATHS[path]);

  const waRows = (d) => rows(d, 'services').map((x) => {
    const src = [x.offers, x.prices, x.options].find(Array.isArray) || (num(x.price) !== null ? [x] : []);
    return {
      id: String(pick(x, ['id', 'service_id']) || ''),
      name: String(pick(x, ['name', 'app_name', 'service_name', 'title', 'id']) || ''),
      free_name: x.free_name === true || x.free_name === 'true' || x.free_name === 1,
      offers: src.map((o) => (o && typeof o === 'object' ? o : { price: o })).filter((o) => num(o.price) !== null)
        .map((o) => ({ base: num(o.price), price: sell(o.price), stock: stockOf(o) }))
    };
  }).filter((x) => x.id);

  const ctRows = (d) => rows(d, 'countries').map((x) => {
    const code = String(pick(x, ['code', 'country', 'id', 'iso']) || '');
    return {
      code,
      name: String(pick(x, ['name', 'country_name', 'nama']) || code),
      flag: pick(x, ['flag', 'emoji']) || '',
      price: sell(x.price),
      stock: stockOf(x),
      on: !(x.on === false || x.on === 'false' || x.on === 0)
    };
  }).filter((x) => x.code);

  async function raw(kind) {
    if (kind === 'wa') return waRows(await ditz('otpwa-services'));
    if (kind === 'sp') return ctRows(await ditz('shopee-countries'));
    return ctRows(await ditz('tg-countries', { app: kind === 'tw' ? 'whatsapp' : 'telegram' }));
  }
  async function list(kind) {
    const l = await raw(kind);
    return kind === 'wa'
      ? l.map((x) => ({ id: x.id, name: x.name, free_name: x.free_name, offers: x.offers.map((o) => ({ price: o.price, stock: o.stock })) }))
      : l;
  }

  async function quote(kind, b) {
    const l = await raw(kind);
    if (kind === 'wa') {
      const id = String(b.service_id == null ? '' : b.service_id);
      if (!/^[\w.\-]{1,40}$/.test(id)) throw fail(400, 'invalid_param', 'service_id tidak valid');
      const svc = l.find((x) => x.id === id);
      const price = Math.round(Number(b.price));
      const offer = svc && svc.offers.find((o) => Math.round(o.price) === price);
      if (!offer) throw fail(404, 'service_unavailable', 'Layanan atau harga tidak tersedia, muat ulang daftar');
      if (offer.stock === 0) throw fail(409, 'out_of_stock', 'Stok habis');
      const params = { service_id: svc.id, price: offer.base };
      if (svc.free_name) {
        const nm = String(b.app_name || '').trim();
        if (nm.length < 2 || nm.length > 40) throw fail(400, 'invalid_param', 'app_name wajib diisi (2 sampai 40 karakter) untuk layanan ini');
        params.app_name = nm;
      }
      return { kind, price: offer.price, name: svc.name + (params.app_name ? ' (' + params.app_name + ')' : ''), call: 'otpwa-buy', params };
    }
    const code = String(b.country || '');
    if (!/^[A-Za-z0-9]{1,8}$/.test(code)) throw fail(400, 'invalid_param', 'country tidak valid');
    const row = l.find((x) => low(x.code) === low(code));
    if (!row) throw fail(404, 'service_unavailable', 'Negara tidak tersedia');
    if (!row.on) throw fail(409, 'maintenance', 'Negara ini sedang maintenance');
    if (row.stock === 0) throw fail(409, 'out_of_stock', 'Stok habis');
    return {
      kind, price: row.price, name: KINDS[kind] + ' - ' + row.name,
      call: kind === 'sp' ? 'shopee-buy' : 'tg-buy',
      params: kind === 'sp' ? { country: row.code } : { app: kind === 'tw' ? 'whatsapp' : 'telegram', country: row.code }
    };
  }

  async function own(u, id, only) {
    if (!/^[\w\-]{8,64}$/.test(String(id || ''))) throw fail(400, 'invalid_param', 'ID order tidak valid');
    const rec = JSON.parse((await R('GET', 'xo:' + id)) || 'null');
    if (!rec || rec.u !== u || (only && !only.includes(rec.kind))) throw fail(404, 'not_found', 'Order tidak ditemukan');
    return rec;
  }

  async function buy(u, kind, b) {
    const q = await quote(kindOf(kind), b);
    if (!(q.price > 0)) throw fail(400, 'invalid_param', 'Harga belum tersedia');
    const left = await R('DECRBY', 'bal:' + u, q.price);
    if (left < 0) { await credit(u, q.price); throw fail(402, 'insufficient_balance', 'Saldo tidak cukup', { balance: left + q.price, price: q.price }); }
    let d;
    try { d = await ditz(q.call, q.params); } catch (e) { await credit(u, q.price); throw e; }
    const id = String(pick(d, ['id', 'order_id', 'uuid']) || '');
    if (!id) { await credit(u, q.price); throw fail(502, 'upstream_invalid', 'Respons penyedia tidak memuat id order'); }
    await R('SET', 'xo:' + id, JSON.stringify({ u, price: q.price, kind, name: q.name, at: Date.now() }), 'EX', 2592000);
    await R('LPUSH', 'xords:' + u, id); await R('LTRIM', 'xords:' + u, 0, 29);
    if (kind !== 'sp') await R('SADD', 'xpend', id);
    await feedPush('order', u, 'order ' + KINDS[kind] + ' Rp ' + q.price.toLocaleString('id-ID'));
    return { ...scrub(d), id, kind, name: q.name, price_sell: q.price, balance: await bal(u) };
  }

  const view = (id, rec, o, extra) => {
    const has = o && Object.keys(o).length > 0;
    const st = low(pick(o, ['status', 'state'])) || (rec.kind === 'sp' ? 'success' : (has ? 'waiting' : 'unknown'));
    let c = pick(o, ['code', 'otp', 'verification_code']);
    if (c != null && low(c) === 'waiting') c = null;
    const n = pick(o, ['number', 'phone', 'nomor']);
    return { id, kind: rec.kind, name: rec.name, status: st, number: n == null ? null : String(n), code: c == null ? null : String(c), price: rec.price, ...extra };
  };

  async function status(u, id, only) {
    const rec = await own(u, id, only);
    let o;
    if (rec.kind === 'wa') o = rows(await ditz('otpwa-orders'), 'orders').find((x) => String(x.id) === id) || {};
    else if (rec.kind === 'sp') o = await ditz('shopee-code', { id });
    else o = await ditz('status', { id });
    const v = view(id, rec, o);
    let refunded = false;
    if (rec.kind !== 'sp' && REFUND.has(v.status)) { await refundOnce(rec.u, id, rec.price); refunded = true; await R('SREM', 'xpend', id); }
    if (v.code && rec.kind !== 'sp') {
      if ((await R('SETNX', 'otpf:' + id, '1')) === 1) await feedPush('otp', u, 'OTP masuk, order selesai');
      await R('SREM', 'xpend', id);
    }
    return { ...v, refunded: refunded || !!(await R('GET', 'ref:' + id)), balance: await bal(u) };
  }

  async function code(u, id, only) {
    const rec = await own(u, id, only);
    let r = null;
    if (rec.kind === 'wa') r = await ditz('otpwa-code', { id });
    else if (rec.kind !== 'sp') throw fail(400, 'invalid_param', 'Order ini menerima kode otomatis, cukup cek status');
    const s = await status(u, id, only);
    const c = pick(r, ['code', 'otp']);
    if (!s.code && c != null) s.code = String(c);
    return s;
  }

  async function cancel(u, id, reason, only) {
    const rec = await own(u, id, only);
    if (rec.kind === 'sp') throw fail(400, 'not_cancelable', 'Akun Shopee tidak bisa dibatalkan. Kirim komplain bila ada masalah');
    if (rec.kind === 'wa') {
      const r = low(reason || 'changed_mind');
      if (!REASONS.includes(r)) throw fail(400, 'invalid_param', 'reason harus salah satu dari: ' + REASONS.join(', '));
      await ditz('otpwa-cancel', { id, reason: r });
    } else await ditz('cancel', { id });
    const refunded = await refundOnce(rec.u, id, rec.price);
    await R('SREM', 'xpend', id);
    await feedPush('cancel', u, 'order dibatalkan, saldo kembali');
    return { id, kind: rec.kind, status: 'canceled', refunded, balance: await bal(u) };
  }

  async function confirm(u, id, only) {
    const rec = await own(u, id, only);
    if (rec.kind !== 'wa') throw fail(400, 'invalid_param', 'Konfirmasi hanya untuk OTP WhatsApp');
    await ditz('otpwa-confirm', { id });
    await R('SREM', 'xpend', id);
    return { id, kind: rec.kind, status: 'confirmed', balance: await bal(u) };
  }

  async function complain(u, id, message, only) {
    const rec = await own(u, id, only);
    if (rec.kind !== 'sp') throw fail(400, 'invalid_param', 'Komplain hanya untuk akun Shopee');
    const m = String(message || '').trim();
    if (m.length < 5 || m.length > 1000) throw fail(400, 'invalid_param', 'message 5 sampai 1000 karakter');
    await ditz('shopee-complain', { id, message: m });
    return { id, sent: true };
  }

  async function orders(u, only) {
    const ids = (await R('LRANGE', 'xords:' + u, 0, 29)) || [];
    const recs = (await Promise.all(ids.map(async (id) => {
      const r = JSON.parse((await R('GET', 'xo:' + id)) || 'null');
      return r && r.u === u ? { id, ...r } : null;
    }))).filter((r) => r && (!only || only.includes(r.kind))).slice(0, 15);
    let wl = null, sl = null;
    const out = [];
    for (const r of recs) {
      let o = {};
      try {
        if (r.kind === 'wa') { wl = wl || rows(await ditz('otpwa-orders'), 'orders'); o = wl.find((x) => String(x.id) === r.id) || {}; }
        else if (r.kind === 'sp') { sl = sl || rows(await ditz('shopee-orders', { limit: 30 }), 'orders'); o = sl.find((x) => String(x.id) === r.id) || {}; }
      } catch (e) { /* tampilkan data lokal saja */ }
      const v = view(r.id, r, o, { created_at: r.at ? new Date(r.at).toISOString() : null });
      if (r.kind === 'sp') { v.email = pick(o, ['email']); v.password = pick(o, ['password', 'pass']); }
      out.push(v);
    }
    return out;
  }

  // Dipanggil dari cron: kembalikan saldo order tertunda yang batal/gagal/kedaluwarsa walau user tidak membuka halamannya
  async function cronPending() {
    const ids = ((await R('SMEMBERS', 'xpend')) || []).slice(0, 60);
    let refunded = 0, wl = null;
    for (const id of ids) {
      try {
        const rec = JSON.parse((await R('GET', 'xo:' + id)) || 'null');
        if (!rec) { await R('SREM', 'xpend', id); continue; }
        let st = '', c = '';
        if (rec.kind === 'wa') {
          wl = wl || rows(await ditz('otpwa-orders'), 'orders');
          const o = wl.find((x) => String(x.id) === id);
          if (!o) continue;
          st = low(o.status); c = pick(o, ['code', 'otp']) || '';
        } else {
          const d = await ditz('status', { id });
          st = low(d.status); c = d.otp && low(d.otp) !== 'waiting' ? d.otp : '';
        }
        if (REFUND.has(st)) {
          if (await refundOnce(rec.u, id, rec.price)) { refunded++; await feedPush('cancel', rec.u, 'order batal/gagal, saldo dikembalikan otomatis'); }
          await R('SREM', 'xpend', id);
        } else if (c) await R('SREM', 'xpend', id);
      } catch (e) { /* dicek lagi di jadwal berikutnya */ }
    }
    return { x_checked: ids.length, x_refunded: refunded };
  }

  return { KINDS, PATHS, kindOf, readyKind, kindOfPath, list, quote, buy, status, code, cancel, confirm, complain, orders, cronPending, guard: own };
}

const X = makeExt({
  R, ditz, sell, bal, credit, feedPush, REFUND,
  refundOnce: async (u, id, p) => ((await R('SETNX', 'ref:' + id, '1')) === 1 ? (await credit(u, p), true) : false),
  fail: (status, code, msg) => new HttpErr(status, msg)
});

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (c, o) => { res.statusCode = c; res.end(JSON.stringify(o)); };
  try {
    if (!KEY()) throw new HttpErr(500, 'DITZ_APIKEY belum diisi');

    if (req.method === 'GET' && req.query && req.query.cron) {   // dipanggil Vercel Cron / pinger luar
      const sec = process.env.CRON_SECRET;
      if (!sec) throw new HttpErr(500, 'CRON_SECRET belum diisi di Vercel');
      const given = String((req.headers && req.headers.authorization) || '').replace(/^Bearer\s+/i, '') || String(req.query.secret || '');
      if (given !== sec) throw new HttpErr(401, 'Tidak diizinkan');
      return send(200, { ...(await cronRefund()), ...(await X.cronPending().catch(() => ({}))) });
    }
    if (req.method === 'GET') {
      const q = req.query || {}, path = String(q.path || '');
      if (!READ.has(path)) throw new HttpErr(400, 'Endpoint tidak diizinkan');
      if (X.PATHS[path]) {   // OTP WhatsApp / Shopee / Telegram-WhatsApp siap pakai: daftar sudah dinormalkan + markup
        const out = await X.list(X.kindOfPath(path, q.app));
        res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
        return send(200, out);
      }
      const p = {};
      for (const k of ['server', 'country', 'service']) if (q[k] !== undefined) p[k] = String(q[k]).slice(0, 40);
      let d = await ditz(path, p);
      if (path === 'services' && Array.isArray(d) && MARKUP()) d = d.map((x) => ({ ...x, price: sell(x.price) }));
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
      return send(200, d);
    }
    if (req.method !== 'POST') throw new HttpErr(405, 'Method tidak didukung');

    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const u = String(b.user || ''), tok = String(b.tok || '');
    if (!/^[a-z0-9_]{3,120}$/.test(u) || !/^[a-f0-9]{32}$/.test(tok)) throw new HttpErr(401, 'Sesi tidak valid, login ulang');
    const h = crypto.createHash('sha256').update(tok).digest('hex');
    if ((await R('SETNX', 'tok:' + u, h)) !== 1 && (await R('GET', 'tok:' + u)) !== h) throw new HttpErr(403, 'Akun ini terikat ke perangkat lain');

    const isAdm = u === kEmail(ADMIN());
    const adminOnly = () => { if (!isAdm) throw new HttpErr(403, 'Khusus admin'); };
    if (!isAdm && (await R('GET', 'ban:' + u))) throw new HttpErr(403, 'Akun kamu diblokir. Hubungi admin.');

    switch (b.action) {
      case 'balance': {
        const out = { balance: await bal(u) };
        if (process.env.ADMIN_EMAIL && u === kEmail(process.env.ADMIN_EMAIL)) out.owner = (await ditz('profile')).balance;
        return send(200, out);
      }
      case 'x_quote': {   // layanan tambahan (wa / sp / tg / tw)
        const k = X.kindOf(String(b.kind || '')), q = await X.quote(k, b);
        return send(200, { price: q.price, name: q.name, balance: await bal(u) });
      }
      case 'x_buy': return send(200, await X.buy(u, String(b.kind || ''), b));
      case 'x_status': return send(200, await X.status(u, b.id));
      case 'x_code': return send(200, await X.code(u, b.id));
      case 'x_cancel': return send(200, await X.cancel(u, b.id, b.reason));
      case 'x_confirm': return send(200, await X.confirm(u, b.id));
      case 'x_complain': return send(200, await X.complain(u, b.id, b.message));
      case 'x_orders': return send(200, { items: await X.orders(u), balance: await bal(u) });
      case 'quote': {
        const { price } = await quote(b);
        return send(200, { price, balance: await bal(u) });
      }
      case 'order': {
        const { o, price } = await quote(b);
        const left = await R('DECRBY', 'bal:' + u, price);
        if (left < 0) { await credit(u, price); throw new HttpErr(400, 'Saldo tidak cukup'); }
        let d;
        try {
          const p = { server: o.server, country: o.country, produk: o.produk };
          if (o.provider) p.provider = o.provider;
          if (['1', '6'].includes(o.server)) p.operator = 'any';
          d = await ditz('order', p);
        } catch (e) { await credit(u, price); throw e; }
        await R('SET', 'ord:' + d.id, JSON.stringify({ u, price }), 'EX', 604800);
        await R('LPUSH', 'ords:' + u, d.id); await R('LTRIM', 'ords:' + u, 0, 9); await R('SADD', 'pend', d.id);
        await userStat(u, 'o', price);
        await feedPush('order', u, 'order dibuat server ' + o.server + ' ' + o.country + '/' + o.produk + ' Rp ' + price.toLocaleString('id-ID'));
        return send(200, { ...d, price_sell: price, balance: await bal(u) });
      }
      case 'status': {
        const rec = await ownOrder(u, b.id);
        const d = await ditz('status', { id: b.id });
        if (REFUND.has(String(d.status).toLowerCase())) await refundOnce(u, b.id, rec.price);
        if (d.otp && String(d.otp).toLowerCase() !== 'waiting' && (await R('SETNX', 'otpf:' + b.id, '1')) === 1) await feedPush('otp', u, 'OTP masuk, order selesai');
        return send(200, { ...d, balance: await bal(u) });
      }
      case 'cancel': {
        const rec = await ownOrder(u, b.id);
        const d = await ditz('cancel', { id: b.id });
        await refundOnce(u, b.id, rec.price);
        await feedPush('cancel', u, 'order dibatalkan, saldo kembali');
        return send(200, { ...d, balance: await bal(u) });
      }
      case 'deposit_create': {
        const nominal = Math.round(Number(b.nominal));
        if (!(nominal >= 1000 && nominal <= 5000000)) throw new HttpErr(400, 'Nominal deposit 1.000 sampai 5.000.000');
        const d = await ditz('deposit/create', { nominal });
        await R('SET', 'dep:' + d.id, u, 'EX', 2592000);
        await R('LPUSH', 'deps:' + u, d.id); await R('LTRIM', 'deps:' + u, 0, 19);
        const out = await inlineQr(d);
        if (isUrl(d.pay_url)) await R('SET', 'pay:' + d.id, d.pay_url, 'EX', 2592000);   // disimpan di server, tidak dikirim ke browser
        return send(200, clean(out));
      }
      case 'deposit_status': {
        await ownDep(u, b.id);
        const d = await checkDep(u, b.id);
        const out = await inlineQr(d);
        return send(200, { ...clean(out), balance: await bal(u) });
      }
      case 'deposit_qr': {   // gambar QR dibuat lewat screenshot; hasilnya di-cache
        await ownDep(u, b.id);
        return send(200, await shotQr(b.id));
      }
      case 'deposit_pay': {   // dipanggil hanya jika QR tidak tersedia: beri link halaman bayar milik deposit ini
        await ownDep(u, b.id);
        const url = await R('GET', 'pay:' + b.id);
        if (!url) throw new HttpErr(404, 'Halaman pembayaran tidak tersedia');
        return send(200, { url });
      }
      case 'deposit_cancel': {
        await ownDep(u, b.id);
        const d = await ditz('deposit/cancel', { id: b.id });
        return send(200, clean(d));
      }
      case 'deposit_history': {
        const ids = (await R('LRANGE', 'deps:' + u, 0, 7)) || [];
        const list = await Promise.all(ids.map((id) => checkDep(u, id).catch(() => null)));
        return send(200, { items: list.filter(Boolean).map((d) => ({ id: d.id, nominal: d.nominal, status: d.status, created_at: d.created_at })), balance: await bal(u) });
      }
      case 'notifs': {
        const l = (await R('LRANGE', 'notifs', 0, 19)) || [];
        return send(200, { items: l.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) });
      }
      case 'apikey_info': {
        const m = JSON.parse((await R('GET', 'apiu:' + u)) || 'null');
        return send(200, m ? { has: true, prefix: m.p, created: m.t } : { has: false });
      }
      case 'apikey_create': {   // key hanya ditampilkan sekali; server menyimpan hash-nya saja. Membuat baru = mencabut yang lama
        const key = 'dtz_' + crypto.randomBytes(24).toString('hex'), hh = crypto.createHash('sha256').update(key).digest('hex');
        const old = JSON.parse((await R('GET', 'apiu:' + u)) || 'null');
        if (old && old.h) await R('DEL', 'apik:' + old.h);
        await R('SET', 'apik:' + hh, u);
        await R('SET', 'apiu:' + u, JSON.stringify({ h: hh, p: key.slice(0, 10), t: Date.now() }));
        return send(200, { key, prefix: key.slice(0, 10) });
      }
      case 'apikey_revoke': {
        const old = JSON.parse((await R('GET', 'apiu:' + u)) || 'null');
        if (old && old.h) await R('DEL', 'apik:' + old.h);
        await R('DEL', 'apiu:' + u);
        return send(200, { ok: true });
      }
      case 'feed': {
        const l = (await R('LRANGE', 'feed', 0, 29)) || [];
        return send(200, { items: l.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) });
      }
      case 'catalog': return send(200, JSON.parse((await R('GET', 'catalog')) || '{}'));
      case 'buy_product': {   // harga diambil dari katalog di server, bukan dari browser
        const c = JSON.parse((await R('GET', 'catalog')) || 'null');
        const p = c && (c.products || []).find((x) => String(x.id) === String(b.id));
        if (!p) throw new HttpErr(400, 'Produk belum tersinkron di server. Minta admin menyimpan ulang produk.');
        const price = Math.round(Number(p.price));
        if (!(price > 0)) throw new HttpErr(400, 'Harga produk belum diisi');
        const left = await R('DECRBY', 'bal:' + u, price);
        if (left < 0) { await credit(u, price); throw new HttpErr(400, 'Saldo tidak cukup'); }
        return send(200, { balance: left, price, name: p.name });
      }
      case 'admin_balance': {
        adminOnly();
        const t = kEmail(b.email), n = Math.round(Number(b.amount));
        if (!/^[a-z0-9_]{3,120}$/.test(t)) throw new HttpErr(400, 'Email user tidak valid');
        if (!(n >= 1 && n <= 100000000)) throw new HttpErr(400, 'Nominal tidak valid');
        if (b.mode === 'sub') {
          const left = await R('DECRBY', 'bal:' + t, n);
          if (left < 0) { await credit(t, n); throw new HttpErr(400, 'Saldo user kurang dari nominal'); }
          return send(200, { balance: left });
        }
        return send(200, { balance: await credit(t, n) });
      }
      case 'admin_ban': {
        adminOnly();
        const t = kEmail(b.email);
        if (!/^[a-z0-9_]{3,120}$/.test(t)) throw new HttpErr(400, 'Email user tidak valid');
        if (t === u) throw new HttpErr(400, 'Tidak bisa memblokir akun sendiri');
        if (b.ban) await R('SET', 'ban:' + t, '1'); else await R('DEL', 'ban:' + t);
        return send(200, { ok: true });
      }
      case 'admin_notify': {
        adminOnly();
        const text = String(b.text || '').trim().slice(0, 200);
        if (!text) throw new HttpErr(400, 'Isi notifikasi');
        await R('LPUSH', 'notifs', JSON.stringify({ id: Date.now().toString(36), text, t: Date.now() }));
        await R('LTRIM', 'notifs', 0, 19);
        return send(200, { ok: true });
      }
      case 'admin_keys': {
        adminOnly();
        if (Array.isArray(b.keys)) {
          const ks = [...new Set(b.keys.map((k) => String(k).trim()).filter(Boolean))];
          if (ks.length > 30) throw new HttpErr(400, 'Maksimal 30 key');
          if (ks.some((k) => !/^[\w\-]{8,80}$/.test(k))) throw new HttpErr(400, 'Format key tidak valid');
          if (ks.length) await R('SET', 'shotkeys', JSON.stringify(ks)); else await R('DEL', 'shotkeys');
        }
        const ks = await shotKeys();
        return send(200, { count: ks.length, masked: ks.map((k) => (k.length > 10 ? k.slice(0, 4) + '…' + k.slice(-4) : '••••')) });
      }
      case 'admin_catalog': {
        adminOnly();
        const S = (v, n) => String(v == null ? '' : v).slice(0, n);
        const products = (Array.isArray(b.products) ? b.products : []).slice(0, 200).map((p) => ({ id: S(p.id, 40), name: S(p.name, 60), category: S(p.category, 20), price: Math.max(0, Math.round(Number(p.price) || 0)), desc: S(p.desc, 160) })).filter((p) => p.id && p.name);
        const cats = (Array.isArray(b.cats) ? b.cats : []).slice(0, 30).map((c) => ({ id: S(c.id, 20), label: S(c.label, 24), icon: S(c.icon, 20), emoji: S(c.emoji, 4) })).filter((c) => c.id && c.label);
        await R('SET', 'catalog', JSON.stringify({ products, cats }));
        return send(200, { ok: true, count: products.length });
      }
      case 'profile_set': {
        const S = (v, n) => String(v == null ? '' : v).slice(0, n);
        const un = S(b.username, 20), em = S(b.email, 80);
        if (!/^[A-Za-z0-9_.]{3,20}$/.test(un)) throw new HttpErr(400, 'Username tidak valid');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) throw new HttpErr(400, 'Email tidak valid');
        let ph = '';
        if (b.photo) {
          ph = String(b.photo);
          if (ph.length > 40000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(ph)) throw new HttpErr(400, 'Foto tidak valid atau terlalu besar');
        }
        let old = {};
        try { old = JSON.parse(await R('HGET', 'prof', u)) || {}; } catch (e) { /* belum ada */ }
        await R('HSET', 'prof', u, JSON.stringify({ u: un, p: ph, e: em, s: old.s || Date.now() }));
        await R('HSET', 'pidx', u, JSON.stringify({ u: un, e: em, s: old.s || Date.now() }));
        return send(200, { ok: true });
      }
      case 'profile_list': {   // daftar semua akun untuk chat private: tanpa email, tanpa foto (foto diambil lewat 'profiles')
        const all = await lightProfiles();
        const list = [];
        for (let i = 0; i + 1 < all.length; i += 2) {
          try { const o = JSON.parse(all[i + 1]); if (o && o.u && o.e) list.push({ k: all[i], c: kEmail(o.e), u: String(o.u), s: Number(o.s) || 0 }); } catch (e) { /* lewati */ }
        }
        list.sort((a, b) => b.s - a.s);
        return send(200, { list: list.slice(0, 500) });
      }
      case 'profiles': {   // username + foto untuk semua; email hanya untuk admin; kata sandi tidak pernah disimpan di server
        const ks = (Array.isArray(b.keys) ? b.keys : []).map(String).filter((k) => /^[a-z0-9_]{3,120}$/.test(k)).slice(0, 40);
        const map = {};
        if (ks.length) {
          const r = (await R('HMGET', 'prof', ...ks)) || [];
          ks.forEach((k, i) => { try { const o = JSON.parse(r[i]); if (o) { map[k] = { u: o.u, p: o.p || '' }; if (isAdm) map[k].e = o.e; } } catch (e) { /* kosong */ } });
        }
        return send(200, { map });
      }
      case 'admin_users': {   // semua user: username, email, saldo, waktu join, status ban, perangkat terikat
        adminOnly();
        const all = await lightProfiles();
        const rows = [];
        for (let i = 0; i + 1 < all.length; i += 2) {
          try { const o = JSON.parse(all[i + 1]); if (o && o.u) rows.push({ k: all[i], u: String(o.u), e: String(o.e || ''), s: Number(o.s) || 0 }); } catch (e) { /* lewati */ }
        }
        rows.sort((a, b) => b.s - a.s);
        const list = rows.slice(0, 1000);
        if (list.length) {
          const ks = list.map((x) => x.k);
          const [bals, bans, toks, notes, tags] = await Promise.all([
            R('MGET', ...ks.map((k) => 'bal:' + k)), R('MGET', ...ks.map((k) => 'ban:' + k)), R('MGET', ...ks.map((k) => 'tok:' + k)), R('HMGET', 'unote', ...ks), R('HMGET', 'utag', ...ks)]);
          list.forEach((x, i) => { x.b = Number(bals[i]) || 0; x.x = bans[i] ? 1 : 0; x.d = toks[i] ? 1 : 0; x.n = (notes && notes[i]) || ''; x.g = (tags && tags[i]) || ''; });
        }
        return send(200, { list, total: rows.length });
      }
      case 'admin_user_detail': {
        adminOnly();
        const t = kEmail(b.email);
        if (!/^[a-z0-9_]{3,120}$/.test(t)) throw new HttpErr(400, 'Email user tidak valid');
        const ids = (await R('LRANGE', 'deps:' + t, 0, 4)) || [];
        const last = await Promise.all(ids.map((id) => ditz('deposit/status', { id }).then((x) => ({ id, n: x.nominal, s: x.status, c: x.created_at })).catch(() => ({ id, s: '?' }))));
        return send(200, { deposits: Number(await R('LLEN', 'deps:' + t)) || 0, apikey: !!(await R('GET', 'apiu:' + t)), last });
      }
      case 'admin_reset_device': {   // lepas ikatan perangkat: user bisa login dari perangkat baru
        adminOnly();
        const t = kEmail(b.email);
        if (!/^[a-z0-9_]{3,120}$/.test(t)) throw new HttpErr(400, 'Email user tidak valid');
        await R('DEL', 'tok:' + t);
        return send(200, { ok: true });
      }
      case 'admin_notify_clear': {
        adminOnly();
        await R('DEL', 'notifs');
        return send(200, { ok: true });
      }
      case 'admin_system': {   // status server, saldo penyedia, latensi database
        adminOnly();
        const t0 = Date.now(); await R('PING'); const ms = Date.now() - t0;
        let provider = null, perr = '';
        try { provider = (await ditz('profile')).balance; } catch (e) { perr = e.message; }
        const ks = await shotKeys();
        return send(200, { redis_ms: ms, users: Number(await R('HLEN', 'prof')) || 0, provider, provider_error: perr, markup: MARKUP(), shotkeys: ks.length, time: Date.now() });
      }
      case 'admin_audit': {
        adminOnly();
        const l = (await R('LRANGE', 'audit', 0, 99)) || [];
        return send(200, { items: l.map((x) => { try { return JSON.parse(x); } catch (e) { return null; } }).filter(Boolean) });
      }
      case 'admin_audit_add': {
        adminOnly();
        await auditLog(b.text);
        return send(200, { ok: true });
      }
      case 'admin_set_balance': {   // set saldo ke nominal tepat
        adminOnly();
        const t = kEmail(b.email), n = Math.round(Number(b.amount));
        if (!/^[a-z0-9_]{3,120}$/.test(t)) throw new HttpErr(400, 'Email user tidak valid');
        if (!(n >= 0 && n <= 100000000)) throw new HttpErr(400, 'Nominal tidak valid');
        const cur = await bal(t);
        if (n !== cur) await R('INCRBY', 'bal:' + t, n - cur);
        await auditLog('Set saldo ' + t + ': ' + cur + ' menjadi ' + n + (b.note ? ' (' + String(b.note).slice(0, 60) + ')' : ''));
        return send(200, { balance: n, before: cur });
      }
      case 'admin_bulk_balance': {   // bonus saldo ke banyak user sekaligus
        adminOnly();
        const n = Math.round(Number(b.amount));
        const ks = [...new Set((Array.isArray(b.keys) ? b.keys : []).map(String).filter((k) => /^[a-z0-9_]{3,120}$/.test(k)))].slice(0, 300);
        if (!(n >= 1 && n <= 10000000)) throw new HttpErr(400, 'Nominal tidak valid (1 sampai 10.000.000)');
        if (!ks.length) throw new HttpErr(400, 'Tidak ada user yang dipilih');
        for (let i = 0; i < ks.length; i += 20) await Promise.all(ks.slice(i, i + 20).map((k) => credit(k, n)));
        await auditLog('Bonus saldo massal Rp ' + n.toLocaleString('id-ID') + ' ke ' + ks.length + ' user' + (b.note ? ' (' + String(b.note).slice(0, 60) + ')' : ''));
        return send(200, { count: ks.length });
      }
      case 'admin_note_set': {   // catatan + label per user
        adminOnly();
        const t = kEmail(b.email), note = String(b.note || '').trim().slice(0, 120), tag = ['VIP', 'Reseller', 'Curiga'].includes(b.tag) ? b.tag : '';
        if (!/^[a-z0-9_]{3,120}$/.test(t)) throw new HttpErr(400, 'Email user tidak valid');
        if (note) await R('HSET', 'unote', t, note); else await R('HDEL', 'unote', t);
        if (tag) await R('HSET', 'utag', t, tag); else await R('HDEL', 'utag', t);
        return send(200, { ok: true });
      }
      case 'admin_bulk_ban': {
        adminOnly();
        const ks = [...new Set((Array.isArray(b.keys) ? b.keys : []).map(String).filter((k) => /^[a-z0-9_]{3,120}$/.test(k) && k !== u))].slice(0, 200);
        if (!ks.length) throw new HttpErr(400, 'Tidak ada user yang dipilih');
        for (let i = 0; i < ks.length; i += 20) await Promise.all(ks.slice(i, i + 20).map((k) => (b.ban ? R('SET', 'ban:' + k, '1') : R('DEL', 'ban:' + k))));
        await auditLog((b.ban ? 'Ban massal ' : 'Unban massal ') + ks.length + ' user');
        return send(200, { count: ks.length });
      }
      case 'global_stats': {   // grafik order & deposit seluruh toko (hanya jumlah, tanpa data pribadi)
        const n = 14;
        try { await ingestFeed(); } catch (e) { /* tetap tampilkan data yang ada */ }
        const days = await Promise.all(Array.from({ length: n }, (_, i) => dayWIB(Date.now() - (n - 1 - i) * 86400000)).map(async (dk) => {
          const [g, e] = await Promise.all([R('HGETALL', 'gst:' + dk), R('HGETALL', 'evd:' + dk)]);
          const G = {}, E = {};
          for (let j = 0; g && j + 1 < g.length; j += 2) G[g[j]] = Number(g[j + 1]) || 0;
          for (let j = 0; e && j + 1 < e.length; j += 2) E[e[j]] = Number(e[j + 1]) || 0;
          return { t: dk, o: Math.max(G.o || 0, E.order || 0), dp: Math.max(G.dp || 0, E.deposit || 0) };
        }));
        return send(200, { days });
      }
      case 'sweep': {   // refund otomatis untuk order yang batal/gagal/kedaluwarsa walau user tidak membuka kartu ordernya
        const ids = (await R('LRANGE', 'ords:' + u, 0, 4)) || [];
        let refunded = 0;
        await Promise.all(ids.map(async (id) => {
          try {
            if (await R('GET', 'ref:' + id)) return;
            const rec = JSON.parse((await R('GET', 'ord:' + id)) || 'null');
            if (!rec || rec.u !== u) return;
            const d = await ditz('status', { id });
            if (REFUND.has(String(d.status).toLowerCase())) { if ((await R('SETNX', 'ref:' + id, '1')) === 1) { await credit(u, rec.price); refunded++; } }
          } catch (e) { /* lewati, dicek lagi nanti */ }
        }));
        return send(200, { refunded, balance: await bal(u) });
      }
      case 'my_stats': {   // grafik order & deposit milik user sendiri (14 hari, WIB)
        const n = 14;
        const days = await Promise.all(Array.from({ length: n }, (_, i) => dayWIB(Date.now() - (n - 1 - i) * 86400000)).map(async (dk) => {
          const h = (await R('HGETALL', 'ust:' + u + ':' + dk)) || [], o = { t: dk, o: 0, os: 0, dp: 0, dps: 0 };
          for (let j = 0; j + 1 < h.length; j += 2) o[h[j]] = Number(h[j + 1]) || 0;
          return o;
        }));
        return send(200, { days });
      }
      case 'admin_events': {   // rekap order/deposit per hari (WIB), dihimpun dari feed dan disimpan permanen
        adminOnly();
        const day = dayWIB;
        await ingestFeed();
        const n = Math.min(30, Math.max(7, Number(b.days) || 30));
        const days = await Promise.all(Array.from({ length: n }, (_, i) => day(Date.now() - (n - 1 - i) * 86400000)).map(async (dk) => {
          const h = (await R('HGETALL', 'evd:' + dk)) || [], o = { d: dk };
          for (let j = 0; j + 1 < h.length; j += 2) o[h[j]] = Number(h[j + 1]) || 0;
          return o;
        }));
        return send(200, { days });
      }
      default: throw new HttpErr(400, 'Aksi tidak dikenal');
    }
  } catch (e) {
    send(e.code || 500, { detail: e.message || 'Terjadi kesalahan' });
  }
};
