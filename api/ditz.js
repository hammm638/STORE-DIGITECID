// Vercel Serverless Function: /api/ditz  (simpan sebagai api/ditz.js)
// Semua kredensial dibaca dari Environment Variables Vercel (Project > Settings > Environment Variables):
//   DITZ_APIKEY, UPSTASH_URL, UPSTASH_TOKEN, SITESHOT_KEY   (opsional: DITZ_MARKUP, ADMIN_EMAIL)
// Respons deposit membawa pay_url (halaman pembayaran QRIS Midtrans) ke browser. snap_token dan link penyedia lain tetap disembunyikan.

const crypto = require('crypto');
const BASE = 'https://www.ditznesia.com/api/dev/';
const KEY = () => 'ae4674b4b4b9d22a91d8c2615a976ceb';
const MARKUP = () => Number(process.env.DITZ_MARKUP || 0);
const RURL = () => 'https://striking-macaque-209704.upstash.io';
const RTOK = () => 'gQAAAAAAAzMoAAIgcDIzOWE4YzMwMzhmMWQ0MDczOTJmZjdkYWJhMGZkMjFhNA';
const READ = new Set(['countries', 'services', 'operators']);
const REFUND = new Set(['canceled', 'cancelled', 'expired', 'failed', 'refunded', 'timeout', 'batal', 'kadaluarsa']);
const kEmail = (e) => String(e || '').toLowerCase().replace(/[^a-z0-9]/g, '_');
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
  var done=false,n=0,lastClick=0;
  function T(e){return (e.innerText||e.textContent||'').replace(/\\s+/g,' ').trim()}
  function qrEl(){
    var c=[].slice.call(document.querySelectorAll('img,canvas')).filter(function(e){
      var r=e.getBoundingClientRect();
      return r.width>=120&&r.height>=120&&Math.abs(r.width-r.height)<10&&!/logo|icon/i.test((e.className||'')+(e.alt||'')+(e.src||''));
    });
    return c.sort(function(a,b){return b.getBoundingClientRect().width-a.getBoundingClientRect().width})[0];
  }
  function clickQris(){
    var all=[].slice.call(document.querySelectorAll('a,button,li,div,span,p')).filter(function(e){var t=T(e);return t&&t.length<45&&/qris/i.test(t)});
    all.sort(function(a,b){return T(a).length-T(b).length});
    var el=all[0];if(!el)return;
    var tg=el.closest('a,button,[role=button],li,[class*=item],[class*=list]')||el;
    try{tg.click()}catch(e){}
  }
  function show(el){
    var src=el.tagName==='CANVAS'?el.toDataURL('image/png'):(el.currentSrc||el.src);
    var w=document.createElement('div');
    w.style.cssText='position:fixed;left:0;top:0;width:100vw;height:100vh;background:#fff;z-index:2147483647;display:flex;align-items:center;justify-content:center';
    var i=new Image();i.style.cssText='width:360px;height:360px;image-rendering:pixelated';
    i.onload=function(){document.body.appendChild(w);var m=document.createElement('div');m.id='__qr_ok';m.style.display='none';document.body.appendChild(m)};
    i.src=src;w.appendChild(i);
  }
  var t=setInterval(function(){
    if(done||++n>60){clearInterval(t);return}
    var q=qrEl();
    if(q){done=true;clearInterval(t);try{show(q)}catch(e){}return}
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
  const out = {};
  try {
    const p = new URLSearchParams({
      url: pay, userkey: SHOT_KEY(), width: '420', height: '420', format: 'png', response_type: 'json',
      delay_time: '9000', timeout: '50000', fresh_session: '1', source_code: '1', javascript_code: QR_JS,
    });
    const r = await fetch('https://api.site-shot.com/?' + p.toString());
    const t = await r.text();
    let j = {}; try { j = JSON.parse(t); } catch (e) { /* bukan JSON */ }
    const im = String(j.image || '');
    const hasSource = Object.keys(j).some((k) => /source/i.test(k));
    if (j.error || !im) out.qr_err = 'Screenshot: ' + String(j.error || ('HTTP ' + r.status)).slice(0, 100);
    else if (hasSource && t.indexOf('__qr_ok') < 0) out.qr_err = 'QR belum muncul di halaman pembayaran';
    else out.qr_link = im.startsWith('data:') ? im : 'data:image/png;base64,' + im;
  } catch (e) { out.qr_err = 'Gagal mengambil screenshot'; }
  await R('SET', 'qrimg:' + id, JSON.stringify(out), 'EX', out.qr_link ? 3600 : 30);   // gagal: boleh coba lagi setelah 30 detik
  await R('DEL', 'qrlock:' + id);
  return out;
}

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
  if (d.status === 'berhasil' && (await R('SETNX', 'cred:' + id, '1')) === 1) await credit(u, d.total_diterima || d.nominal);
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
        return send(200, { ...d, price_sell: price, balance: await bal(u) });
      }
      case 'status': {
        const rec = await ownOrder(u, b.id);
        const d = await ditz('status', { id: b.id });
        if (REFUND.has(String(d.status).toLowerCase())) await refundOnce(u, b.id, rec.price);
        return send(200, { ...d, balance: await bal(u) });
      }
      case 'cancel': {
        const rec = await ownOrder(u, b.id);
        const d = await ditz('cancel', { id: b.id });
        await refundOnce(u, b.id, rec.price);
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
      default: throw new HttpErr(400, 'Aksi tidak dikenal');
    }
  } catch (e) {
    send(e.code || 500, { detail: e.message || 'Terjadi kesalahan' });
  }
};
