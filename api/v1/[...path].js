/* DIGITECID API v1 - endpoint publik. Auth: header X-API-Key. Saldo = saldo akun situs (Redis bal:<user>), bukan saldo ditznesia.
   Env Vercel: DITZ_APIKEY, UPSTASH_URL, UPSTASH_TOKEN (opsional: DITZ_MARKUP, SITESHOT_KEY)
   QR deposit lewat screenshot (GET /deposits/{id}/qr) memakai daftar key Site-Shot (SHOT_KEYS di file ini, bergiliran), ditambah 'shotkeys' di Redis dan SITESHOT_KEY bila ada. */
const crypto = require('crypto');
const BASE = 'https://www.ditznesia.com/api/dev/';
const E = (k) => process.env[k] || '';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sell = (p) => Math.round(Number(p || 0) * (1 + Number(process.env.DITZ_MARKUP || 0) / 100));
const REFUND = new Set(['canceled', 'cancelled', 'expired', 'failed', 'refunded', 'timeout', 'batal', 'kadaluarsa']);

class HttpErr extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

async function R(...cmd) {
  const url = E('UPSTASH_URL'), tok = E('UPSTASH_TOKEN');
  if (!url || !tok) throw new HttpErr(500, 'server_misconfigured', 'Database belum dikonfigurasi di server');
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok },
    body: JSON.stringify(cmd)
  });
  const j = await r.json();
  if (j.error) throw new HttpErr(500, 'database_error', 'Database error');
  return j.result;
}

async function ditz(path, params) {
  const key = E('DITZ_APIKEY');
  if (!key) throw new HttpErr(500, 'server_misconfigured', 'Penyedia belum dikonfigurasi di server');
  const p = new URLSearchParams(params || {});
  p.set('apikey', key);

  let r, t;
  try {
    r = await fetch(BASE + path + '?' + p.toString());
    t = await r.text();
  } catch (e) {
    throw new HttpErr(502, 'upstream_unreachable', 'Penyedia tidak dapat dihubungi');
  }

  let d;
  try {
    d = JSON.parse(t);
  } catch (e) {
    throw new HttpErr(502, 'upstream_invalid', 'Respons penyedia tidak valid');
  }

  if (!r.ok || (d && !Array.isArray(d) && d.detail)) {
    throw new HttpErr(
      r.status >= 500 ? 502 : 400,
      'upstream_rejected',
      (d && d.detail) || ('HTTP ' + r.status)
    );
  }

  return d;
}

const bal = async (u) => Number(await R('GET', 'bal:' + u)) || 0;
const credit = (u, n) => R('INCRBY', 'bal:' + u, Math.round(n));

const refundOnce = async (u, id, price) =>
  (await R('SETNX', 'ref:' + id, '1')) === 1
    ? (await credit(u, price), true)
    : false;

const mask = (u) => {
  const s = String(u || '');
  return s.slice(0, 2) + '***' + s.slice(-1);
};

const feedPush = async (k, u, x) => {
  try {
    await R('LPUSH', 'feed', JSON.stringify({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      k,
      u: mask(u),
      x,
      t: Date.now()
    }));
    await R('LTRIM', 'feed', 0, 49);
  } catch (e) {
    /* feed tidak boleh menggagalkan order */
  }
};

/* ---- pembersihan respons deposit ---- */
const isUrl = (v) =>
  typeof v === 'string' && /^(https?:)?\/\//i.test(v.trim());

const isMidtrans = (v) => {
  try {
    return /(^|\.)midtrans\.com$/i.test(new URL(String(v).trim()).hostname);
  } catch (e) {
    return false;
  }
};

function clean(d) {
  const o = { ...d };
  const pay = isMidtrans(o.pay_url) ? String(o.pay_url).trim() : '';

  ['snap_token', 'payment_url', 'redirect_url', 'token', 'pay_url']
    .forEach((k) => delete o[k]);

  Object.keys(o).forEach((k) => {
    if (k !== 'qr_link' && isUrl(o[k])) delete o[k];
  });

  if (pay) o.pay_url = pay;
  return o;
}

async function inlineQr(d) {
  const o = { ...d };

  if (isUrl(o.qr_link)) {
    try {
      const ir = await fetch(o.qr_link.trim().replace(/^\/\//, 'https://'));
      const ct = (ir.headers.get('content-type') || '').split(';')[0];

      o.qr_link =
        ir.ok && /^image\//i.test(ct)
          ? 'data:' + ct + ';base64,' +
            Buffer.from(await ir.arrayBuffer()).toString('base64')
          : null;
    } catch (e) {
      o.qr_link = null;
    }
  }

  return o;
}

/* ---- QR lewat screenshot (Site-Shot): sama seperti di situs, hasilnya berbagi cache qrimg:<id> ---- */
const SHOT_W = 420, SHOT_H = 620, SHOT_TOP = 222, SHOT_SHOW = 340;   // ukuran gambar dan bagian yang berisi QR (px)
// Key Site-Shot: dipakai bergiliran (round-robin) di setiap pembuatan QR; kalau satu key ditolak/kuota habis, otomatis lanjut ke key berikutnya
const SHOT_KEYS = [
  '5TNOATCPJRLQZWWW4NUKDOTWPM',
  '3BYBWIJ3SJ4VB5QIFQQRO7TJ2M',
  '77ZXEAI7SKSVSVAJLDZ5G4MMDU',
  'EZP5PL4P5HMFXOQBHGQBOQZ3OA',
  'XWHXKORP46MFRKG7ZCWCU4HH5U',
  'GEM7SJJ7XENYMSCXUQDVPU6FDY',
  'DAANZMQSWVOOCZVF7ET5KSU6G4'
];
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

async function shotKeys() {
  let extra = [];
  try {
    const l = JSON.parse((await R('GET', 'shotkeys')) || '[]');
    if (Array.isArray(l)) extra = l.map(String);
  } catch (e) {
    /* abaikan, pakai key di file */
  }
  const env = E('SITESHOT_KEY');
  return [...new Set([...SHOT_KEYS, ...extra, ...(env ? [env] : [])].map((k) => String(k).trim()).filter(Boolean))];
}

async function shotQr(id) {
  const cached = await R('GET', 'qrimg:' + id);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* cache rusak, buat ulang */ }
  }

  const pay = await R('GET', 'pay:' + id);
  if (!pay || !isMidtrans(pay)) return { qr_err: 'Halaman pembayaran tidak tersedia' };

  const keys = await shotKeys();
  if (!keys.length) return { qr_err: 'Key Site-Shot belum diisi di server' };

  // sedang dibuat oleh permintaan lain
  if ((await R('SET', 'qrlock:' + id, '1', 'NX', 'EX', 90)) !== 'OK') return { qr_pending: true };

  let out = {};

  try {
    const st = (await R('INCR', 'shotrr')) % keys.length;

    for (let a = 0; a < Math.min(keys.length, 7); a++) {
      out = {};
      const key = keys[(st + a) % keys.length];

      try {
        const p = new URLSearchParams({
          url: pay,
          userkey: key,
          width: String(SHOT_W),
          height: String(SHOT_H),
          format: 'png',
          response_type: 'json',
          delay_time: '9000',
          timeout: '50000',
          fresh_session: '1',
          javascript_code: QR_JS
        });

        const r = await fetch('https://api.site-shot.com/?' + p.toString());
        const t = await r.text();

        let j = {};
        try { j = JSON.parse(t); } catch (e) { /* bukan JSON */ }

        const im = String(j.image || '');

        if (r.status === 429) {
          out.qr_err = 'Screenshot ditolak (429): kuota atau batas permintaan Site-Shot tercapai. ' +
            String(j.error || t || '').replace(/\s+/g, ' ').slice(0, 100);
          out.wait = 120;
          out.retry = true;
        } else if (r.status === 401 || r.status === 402 || r.status === 403) {
          out.qr_err = 'Screenshot: key ditolak (HTTP ' + r.status + ') ' + String(j.error || '').slice(0, 80);
          out.retry = true;
        } else if (j.error || !im) {
          out.qr_err = 'Screenshot: ' + String(j.error || ('HTTP ' + r.status)).slice(0, 100);
        } else {
          out.qr_link = im.startsWith('data:') ? im : 'data:image/png;base64,' + im;
          out.shot = true;
        }
      } catch (e) {
        out.qr_err = 'Gagal mengambil screenshot';
      }

      // lanjut ke key berikutnya hanya jika key ditolak atau kena batas (401/402/403/429)
      if (out.qr_link || !out.retry) break;
    }

    // berhasil: simpan 1 jam. gagal: coba lagi setelah 30 detik (429: 2 menit)
    const ttl = out.qr_link ? 3600 : (out.wait || 30);
    delete out.wait;
    delete out.retry;
    await R('SET', 'qrimg:' + id, JSON.stringify(out), 'EX', ttl);
  } finally {
    await R('DEL', 'qrlock:' + id);
  }

  return out;
}

/* ---- util ---- */
function pick(b) {
  const server = String(b.server || '');
  const country = String(b.country || '');
  const service = String(b.service || '');
  const provider = b.provider == null ? '' : String(b.provider);

  if (!/^[1-6]$/.test(server))
    throw new HttpErr(400, 'invalid_param', 'server harus 1 sampai 6');

  if (!/^[A-Za-z0-9]{1,8}$/.test(country))
    throw new HttpErr(400, 'invalid_param', 'country tidak valid');

  // FIX: id layanan dari provider bisa berbentuk "wa|0.06", jadi karakter | ikut diizinkan
  if (!/^[\w.\-|]{1,40}$/.test(service))
    throw new HttpErr(400, 'invalid_param', 'service tidak valid');

  if (!/^[\w.\-|]{0,40}$/.test(provider))
    throw new HttpErr(400, 'invalid_param', 'provider tidak valid');

  return { server, country, service, provider };
}

async function quote(o) {
  const list = await ditz('services', {
    server: o.server,
    country: o.country,
    service: o.service
  });

  const item = (Array.isArray(list) ? list : []).find((x) =>
    (String(x.id) === o.service || String(x.produk) === o.service) &&
    (!o.provider || String(x.provider) === o.provider)
  );

  if (!item)
    throw new HttpErr(404, 'service_unavailable', 'Layanan tidak tersedia atau stok habis');

  return {
    price: sell(item.price),
    name: String(item.service_name || item.produk || item.id)
  };
}

async function ownOrder(u, id) {
  if (!/^[\w\-]{8,64}$/.test(String(id || '')))
    throw new HttpErr(400, 'invalid_param', 'ID order tidak valid');

  const rec = JSON.parse((await R('GET', 'ord:' + id)) || 'null');

  if (!rec || rec.u !== u)
    throw new HttpErr(404, 'not_found', 'Order tidak ditemukan');

  return rec;
}

async function ownDep(u, id) {
  if (
    !/^[\w\-]{3,64}$/.test(String(id || '')) ||
    (await R('GET', 'dep:' + id)) !== u
  ) {
    throw new HttpErr(404, 'not_found', 'Deposit tidak ditemukan');
  }
}

async function checkDep(u, id) {
  const d = await ditz('deposit/status', { id });

  if (
    d.status === 'berhasil' &&
    (await R('SETNX', 'cred:' + id, '1')) === 1
  ) {
    await credit(u, d.total_diterima || d.nominal);
    await feedPush(
      'deposit',
      u,
      'deposit berhasil Rp ' + Number(d.nominal || 0).toLocaleString('id-ID')
    );
  }

  return d;
}

async function auth(req) {
  const raw =
    String(req.headers['x-api-key'] || '').trim() ||
    String(req.headers.authorization || '')
      .replace(/^Bearer\s+/i, '')
      .trim();

  if (!/^dtz_[a-f0-9]{48}$/.test(raw)) {
    throw new HttpErr(
      401,
      'invalid_api_key',
      'API key tidak dikirim atau formatnya salah. Kirim lewat header X-API-Key.'
    );
  }

  const hash = sha(raw);
  const u = await R('GET', 'apik:' + hash);

  if (!u)
    throw new HttpErr(401, 'invalid_api_key', 'API key tidak dikenal atau sudah dicabut');

  if (await R('GET', 'ban:' + u))
    throw new HttpErr(403, 'account_banned', 'Akun diblokir. Hubungi admin.');

  return { u, hash };
}

async function limit(hash, max, res) {
  const w = Math.floor(Date.now() / 60000);
  const k = 'rl:' + hash + ':' + w;
  const c = await R('INCR', k);

  if (c === 1) await R('EXPIRE', k, 70);

  res.setHeader('X-RateLimit-Limit', String(max));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - c)));

  if (c > max) {
    const ra = 60 - (Math.floor(Date.now() / 1000) % 60);
    res.setHeader('Retry-After', String(ra));
    throw new HttpErr(
      429,
      'rate_limited',
      'Terlalu banyak permintaan. Coba lagi sebentar.',
      { retry_after: ra }
    );
  }
}

function body(req) {
  if (req.method !== 'POST') return {};
  if (req.body && typeof req.body === 'object') return req.body;

  try {
    return JSON.parse(req.body || '{}');
  } catch (e) {
    throw new HttpErr(400, 'invalid_json', 'Body harus JSON yang valid');
  }
}

/* Idempotency-Key */
async function idem(req, res, hash, fn) {
  const k = String(req.headers['idempotency-key'] || '').trim();

  if (!k) return fn();

  if (!/^[\w\-]{8,64}$/.test(k)) {
    throw new HttpErr(
      400,
      'invalid_param',
      'Idempotency-Key 8 sampai 64 karakter (huruf, angka, - dan _)'
    );
  }

  const ik = 'idem:' + hash + ':' + k;
  const got = await R('GET', ik);

  if (got && got !== 'pending') {
    res.setHeader('Idempotent-Replay', 'true');
    return JSON.parse(got);
  }

  if (
    got === 'pending' ||
    (await R('SET', ik, 'pending', 'NX', 'EX', 120)) !== 'OK'
  ) {
    throw new HttpErr(
      409,
      'request_in_progress',
      'Permintaan dengan Idempotency-Key ini sedang diproses'
    );
  }

  try {
    const out = await fn();
    await R('SET', ik, JSON.stringify(out), 'EX', 86400);
    return out;
  } catch (e) {
    await R('DEL', ik);
    throw e;
  }
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
    /* Kalau OTP/kode sudah masuk, order dianggap selesai dan tidak boleh dibatalkan / direfund */
    let got = null;
    if (rec.kind === 'wa') {
      const od = rows(await ditz('otpwa-orders'), 'orders').find((x) => String(x.id) === id) || {};
      got = pick(od, ['code', 'otp', 'verification_code']);
    } else {
      const sd = await ditz('status', { id });
      got = pick(sd, ['otp', 'code']);
    }
    if (got != null && low(got) !== 'waiting') throw fail(409, 'otp_received', 'OTP sudah masuk, order tidak bisa dibatalkan');
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
  R, ditz, sell, bal, credit, feedPush, REFUND, refundOnce,
  fail: (status, code, msg, extra) => new HttpErr(status, code, msg, extra)
});

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type,Authorization,X-API-Key,Idempotency-Key'
  );
  res.setHeader(
    'Access-Control-Expose-Headers',
    'X-RateLimit-Limit,X-RateLimit-Remaining,Retry-After,Idempotent-Replay'
  );

  const send = (s, data) => {
    res.statusCode = s;
    res.end(JSON.stringify({ ok: true, data }));
  };

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  try {
    const q = req.query || {};

    /*
     * FIX:
     * Jika q.path kosong, ambil route dari req.url.
     */
    let parts = [];

    if (q.path !== undefined && q.path !== null) {
      const rawPath = Array.isArray(q.path) ? q.path : [q.path];

      parts = rawPath
        .flatMap((value) => String(value).split('/'))
        .filter(Boolean);
    }

    if (!parts.length) {
      const pathname = new URL(
        req.url || '/',
        'https://vercel.invalid'
      ).pathname;

      const marker = '/api/v1/';
      const markerIndex = pathname.indexOf(marker);

      const routePath = markerIndex >= 0
        ? pathname.slice(markerIndex + marker.length)
        : pathname.replace(/^\/+/, '');

      parts = routePath.split('/').filter(Boolean);
    }

    if (parts[0] === 'api' && parts[1] === 'v1') {
      parts = parts.slice(2);
    } else if (parts[0] === 'v1') {
      parts = parts.slice(1);
    }

    parts = parts.map((value) =>
      decodeURIComponent(String(value))
    );

    let [a, b, c] = parts;
    const m = req.method;

    /* Bentuk datar (tanpa sub-path), untuk lingkungan yang hanya meneruskan 1 segmen:
       /orders?id=X, /orders?id=X&action=cancel, /deposits?id=X, /deposits?id=X&action=qr|cancel */
    if ((a === 'orders' || a === 'deposits') && !b && q.id) {
      b = String(q.id);
      c = q.action ? String(q.action) : undefined;
    }

    if (a === 'ping' && m === 'GET' && !b) {
      return send(200, {
        service: 'digitecid-api',
        version: 'v1',
        time: new Date().toISOString()
      });
    }

    const { u, hash } = await auth(req);
    await limit(hash, m === 'POST' ? 20 : 60, res);

    const B = body(req);

    if (a === 'me' && m === 'GET' && !b) {
      const meta = JSON.parse(
        (await R('GET', 'apiu:' + u)) || 'null'
      ) || {};

      return send(200, {
        balance: await bal(u),
        key_prefix: meta.p || null,
        key_created_at: meta.t
          ? new Date(meta.t).toISOString()
          : null
      });
    }

    if (a === 'balance' && m === 'GET' && !b) {
      return send(200, { balance: await bal(u) });
    }

    if (a === 'countries' && m === 'GET' && !b) {
      const server = String(q.server || '1');

      if (!/^[1-6]$/.test(server)) {
        throw new HttpErr(400, 'invalid_param', 'server harus 1 sampai 6');
      }

      const d = await ditz('countries', { server });
      const list = Array.isArray(d)
        ? d
        : (d && d.countries) || [];

      return send(200, {
        server,
        countries: list.map((x) => ({
          code: x.code,
          name: x.name
        }))
      });
    }

    if (a === 'services' && m === 'GET' && !b) {
      const server = String(q.server || '');
      const country = String(q.country || '');

      if (!/^[1-6]$/.test(server)) {
        throw new HttpErr(400, 'invalid_param', 'server harus 1 sampai 6');
      }

      if (!/^[A-Za-z0-9]{1,8}$/.test(country)) {
        throw new HttpErr(400, 'invalid_param', 'country wajib diisi');
      }

      const p = { server, country };

      if (q.service) {
        p.service = String(q.service).slice(0, 40);
      }

      const d = await ditz('services', p);
      const list = Array.isArray(d)
        ? d
        : (d && d.services) || [];

      return send(200, {
        server,
        country,
        services: list.map((x) => {
          const o = {
            id: String(x.id || x.produk),
            name: String(x.service_name || x.produk || x.id),
            provider: x.provider == null
              ? null
              : String(x.provider),
            price: sell(x.price)
          };

          const st = x.stock != null ? x.stock : x.stok;
          if (st != null) o.stock = st;

          return o;
        })
      });
    }

    if (a === 'orders') {
      if (!b && m === 'POST') {
        return send(201, await idem(req, res, hash, async () => {
          const o = pick(B);
          const { price, name } = await quote(o);

          const left = await R('DECRBY', 'bal:' + u, price);

          if (left < 0) {
            await credit(u, price);
            throw new HttpErr(
              402,
              'insufficient_balance',
              'Saldo tidak cukup',
              { balance: left + price, price }
            );
          }

          let d;

          try {
            const p = {
              server: o.server,
              country: o.country,
              produk: o.service
            };

            if (o.provider) p.provider = o.provider;
            if (['1', '6'].includes(o.server)) p.operator = 'any';

            d = await ditz('order', p);
          } catch (e) {
            await credit(u, price);
            throw e;
          }

          const at = Date.now();

          await R(
            'SET',
            'ord:' + d.id,
            JSON.stringify({
              u,
              price,
              src: 'api',
              at,
              server: o.server,
              country: o.country,
              service: o.service,
              name
            }),
            'EX',
            604800
          );

          await R('LPUSH', 'ords:' + u, d.id);
          await R('LTRIM', 'ords:' + u, 0, 49);

          await feedPush(
            'order',
            u,
            'order dibuat server ' + o.server + ' ' +
            o.country + '/' + o.service + ' Rp ' +
            price.toLocaleString('id-ID')
          );

          const exp = Number(d.expires_at_ms) || null;

          return {
            id: d.id,
            number: d.number,
            status: 'waiting',
            service: name,
            country: o.country,
            server: o.server,
            price,
            balance: await bal(u),
            created_at: new Date(at).toISOString(),
            expires_at: exp
              ? new Date(exp).toISOString()
              : null
          };
        }));
      }

      if (!b && m === 'GET') {
        const ids = (await R('LRANGE', 'ords:' + u, 0, 19)) || [];

        const recs = await Promise.all(ids.map(async (id) => {
          const r = JSON.parse(
            (await R('GET', 'ord:' + id)) || 'null'
          );

          return r && r.u === u
            ? {
                id,
                service: r.name,
                country: r.country,
                server: r.server,
                price: r.price,
                created_at: r.at
                  ? new Date(r.at).toISOString()
                  : null
              }
            : null;
        }));

        return send(200, {
          orders: recs.filter(Boolean)
        });
      }

      if (b && !c && m === 'GET') {
        const rec = await ownOrder(u, b);
        const d = await ditz('status', { id: b });
        const st = String(d.status || '').toLowerCase();

        let refunded = false;

        if (REFUND.has(st)) {
          await refundOnce(u, b, rec.price);
          refunded = true;
        }

        const otp =
          d.otp && String(d.otp).toLowerCase() !== 'waiting'
            ? String(d.otp)
            : null;

        if (otp && (await R('SETNX', 'otpf:' + b, '1')) === 1) {
          await feedPush('otp', u, 'OTP masuk, order selesai');
        }

        return send(200, {
          id: b,
          number: d.number || null,
          status: st,
          otp,
          price: rec.price,
          refunded,
          balance: await bal(u)
        });
      }

      if (b && c === 'cancel' && m === 'POST') {
        const rec = await ownOrder(u, b);

        /* Kalau OTP sudah masuk, order dianggap selesai dan tidak boleh dibatalkan / direfund */
        const cur = await ditz('status', { id: b });
        if (cur.otp && String(cur.otp).toLowerCase() !== 'waiting') {
          throw new HttpErr(409, 'otp_received', 'OTP sudah masuk, order tidak bisa dibatalkan');
        }

        await ditz('cancel', { id: b });

        const refunded = await refundOnce(u, b, rec.price);

        await feedPush(
          'cancel',
          u,
          'order dibatalkan, saldo kembali'
        );

        return send(200, {
          id: b,
          status: 'canceled',
          refunded,
          balance: await bal(u)
        });
      }
    }

    if (a === 'deposits') {
      if (!b && m === 'POST') {
        return send(201, await idem(req, res, hash, async () => {
          const nominal = Math.round(Number(B.nominal));

          if (!(nominal >= 1000 && nominal <= 5000000)) {
            throw new HttpErr(
              400,
              'invalid_param',
              'nominal 1000 sampai 5000000'
            );
          }

          const d = await ditz('deposit/create', { nominal });

          await R('SET', 'dep:' + d.id, u, 'EX', 2592000);
          await R('LPUSH', 'deps:' + u, d.id);
          await R('LTRIM', 'deps:' + u, 0, 19);

          if (isUrl(d.pay_url)) {
            await R('SET', 'pay:' + d.id, d.pay_url, 'EX', 2592000);
          }

          return clean(await inlineQr(d));
        }));
      }

      if (!b && m === 'GET') {
        const ids = (await R('LRANGE', 'deps:' + u, 0, 7)) || [];

        const list = await Promise.all(
          ids.map(async (id) =>
            checkDep(u, id).catch(() => null)
          )
        );

        return send(200, {
          deposits: list.filter(Boolean).map((d) => ({
            id: d.id,
            nominal: d.nominal,
            status: d.status,
            created_at: d.created_at
          })),
          balance: await bal(u)
        });
      }

      if (b && !c && m === 'GET') {
        await ownDep(u, b);
        const d = await checkDep(u, b);

        return send(200, {
          ...clean(await inlineQr(d)),
          balance: await bal(u)
        });
      }

      if (b && c === 'qr' && m === 'GET') {
        await ownDep(u, b);
        const d = await checkDep(u, b);
        const st = String(d.status || '').toLowerCase();

        if (['berhasil', 'batal', 'kadaluarsa'].includes(st)) {
          throw new HttpErr(
            409,
            'deposit_closed',
            'Deposit sudah tidak menunggu pembayaran',
            { status: st, balance: await bal(u) }
          );
        }

        const r = await shotQr(b);
        const out = { id: b, status: st || null, qr_link: r.qr_link || null };

        if (r.qr_link) {
          out.source = 'screenshot';
          out.width = SHOT_W;
          out.height = SHOT_H;
          out.crop = { top: SHOT_TOP, height: SHOT_SHOW };
        } else {
          if (r.qr_pending) out.qr_pending = true;
          if (r.qr_err) out.qr_error = String(r.qr_err);

          const pay = await R('GET', 'pay:' + b);
          if (isMidtrans(pay)) out.pay_url = String(pay).trim();
        }

        out.balance = await bal(u);
        return send(r.qr_pending ? 202 : 200, out);
      }

      if (b && c === 'cancel' && m === 'POST') {
        await ownDep(u, b);

        return send(200, {
          ...clean(await ditz('deposit/cancel', { id: b })),
          balance: await bal(u)
        });
      }
    }

    /* ---- Layanan tambahan: /otpwa, /shopee, /ready (Telegram & WhatsApp siap pakai) ---- */
    if (a === 'otpwa' || a === 'shopee' || a === 'ready') {
      const sub = parts[1], id = parts[2], act = parts[3];
      const group = a === 'otpwa' ? ['wa'] : a === 'shopee' ? ['sp'] : ['tg', 'tw'];

      if (sub === 'services' && a === 'otpwa' && !id && m === 'GET') {
        return send(200, { services: await X.list('wa') });
      }

      if (sub === 'countries' && a !== 'otpwa' && !id && m === 'GET') {
        const kind = a === 'shopee' ? 'sp' : X.readyKind(q.app);
        const out = { countries: await X.list(kind) };
        if (a === 'ready') out.app = kind === 'tw' ? 'whatsapp' : 'telegram';
        return send(200, out);
      }

      if (sub === 'orders') {
        if (!id && m === 'POST') {
          const kind = a === 'otpwa' ? 'wa' : a === 'shopee' ? 'sp' : X.readyKind(B.app);
          return send(201, await idem(req, res, hash, () => X.buy(u, kind, B)));
        }
        if (!id && m === 'GET') return send(200, { orders: await X.orders(u, group) });
        if (id && !act && m === 'GET') return send(200, await X.status(u, id, group));
        if (id && act === 'code' && m === 'POST' && a !== 'ready') return send(200, await X.code(u, id, group));
        if (id && act === 'cancel' && m === 'POST' && a !== 'shopee') return send(200, await X.cancel(u, id, B.reason, group));
        if (id && act === 'confirm' && m === 'POST' && a === 'otpwa') return send(200, await X.confirm(u, id, group));
        if (id && act === 'complain' && m === 'POST' && a === 'shopee') return send(200, await X.complain(u, id, B.message, group));
      }
    }

    throw new HttpErr(
      a ? 404 : 400,
      'not_found',
      'Endpoint tidak ditemukan atau method tidak didukung'
    );

  } catch (e) {
    const status = e.status || 500;

    res.statusCode = status;

    res.end(JSON.stringify({
      ok: false,
      error: {
        code: e.code || 'internal_error',
        message: e.status
          ? e.message
          : 'Terjadi kesalahan di server',
        ...(e.extra || {})
      }
    }));
  }
};
