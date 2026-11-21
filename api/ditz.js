const crypto = require('crypto');
const BASE = 'https://www.ditznesia.com/api/dev/';
const KEY = () => 'ae4674b4b4b9d22a91d8c2615a976ceb';
const MARKUP = () => Number(process.env.DITZ_MARKUP || 0);
const RURL = () => 'https://striking-macaque-209704.upstash.io';
const RTOK = () => 'gQAAAAAAAzMoAAIgcDIzOWE4YzMwMzhmMWQ0MDczOTJmZjdkYWJhMGZkMjFhNA';
const READ = new Set(['countries', 'services', 'operators']);
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
async function refundOnce(u, id, price) { if ((await R('SETNX', 'ref:' + id, '1')) === 1) await credit(u, price); }
async function ownDep(u, id) {
  if (!/^[\w\-]{3,64}$/.test(String(id || '')) || (await R('GET', 'dep:' + id)) !== u) throw new HttpErr(404, 'Deposit tidak ditemukan');
}
async function checkDep(u, id) {
  const d = await ditz('deposit/status', { id });
  if (d.status === 'berhasil' && (await R('SETNX', 'cred:' + id, '1')) === 1) { await credit(u, d.total_diterima || d.nominal); await feedPush('deposit', u, 'deposit berhasil Rp ' + Number(d.nominal || 0).toLocaleString('id-ID')); }
  return d;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (c, o) => { res.statusCode = c; res.end(JSON.stringify(o)); };
  try {
    if (!KEY()) throw new HttpErr(500, 'DITZ_APIKEY belum diisi');

    if (req.method === 'GET') {
      const q = req.query || {}, path = String(q.path || '');
      if (!READ.has(path)) throw new HttpErr(400, 'Endpoint tidak diizinkan');
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
        await R('HSET', 'prof', u, JSON.stringify({ u: un, p: ph, e: em }));
        return send(200, { ok: true });
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
      default: throw new HttpErr(400, 'Aksi tidak dikenal');
    }
  } catch (e) {
    send(e.code || 500, { detail: e.message || 'Terjadi kesalahan' });
  }
};
