// Vercel Serverless Function: /api/ditz
// API key disimpan di Environment Variable Vercel: DITZ_APIKEY (JANGAN ditulis di index.html)
const ALLOWED = new Set(['countries', 'services', 'operators']); // hanya endpoint baca data

module.exports = async (req, res) => {
  const key = process.env.DITZ_APIKEY;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (!key) { res.statusCode = 500; return res.end(JSON.stringify({ detail: 'DITZ_APIKEY belum diisi di Vercel' })); }

  const q = req.query || {};
  const path = String(q.path || '');
  if (!ALLOWED.has(path)) { res.statusCode = 400; return res.end(JSON.stringify({ detail: 'Endpoint tidak diizinkan' })); }

  const p = new URLSearchParams();
  for (const k of ['server', 'country', 'service']) {
    if (q[k] !== undefined) p.set(k, String(q[k]).slice(0, 40));
  }
  p.set('apikey', key);

  try {
    const r = await fetch('https://www.ditznesia.com/api/dev/' + path + '?' + p.toString());
    const text = await r.text();
    res.statusCode = r.status;
    if (r.ok) res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    res.end(text);
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ detail: 'Gagal menghubungi API ditznesia' }));
  }
};
