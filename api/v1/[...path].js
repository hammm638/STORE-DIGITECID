/* DIGITECID API v1 - endpoint publik. Auth: header X-API-Key. Saldo = saldo akun situs (Redis bal:<user>), bukan saldo ditznesia.
   Env Vercel: DITZ_APIKEY, UPSTASH_URL, UPSTASH_TOKEN (opsional: DITZ_MARKUP) */
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

  if (!/^[\w.\-]{1,40}$/.test(service))
    throw new HttpErr(400, 'invalid_param', 'service tidak valid');

  if (!/^[\w.\-]{0,40}$/.test(provider))
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

    const [a, b, c] = parts;
    const m = req.method;

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

      if (b && c === 'cancel' && m === 'POST') {
        await ownDep(u, b);

        return send(200, {
          ...clean(await ditz('deposit/cancel', { id: b })),
          balance: await bal(u)
        });
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
