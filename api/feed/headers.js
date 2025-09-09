// api/feed/headers.js
const { db } = require('../../backend/src/db/firestore');
const downloadFile = require('../../backend/src/core/downloadFile');
const parseData = require('../../backend/src/core/parseData');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const url = String(req.query.url || '').trim();
    if (!url) return res.status(400).json({ error: 'Hiányzik: url' });

    // 1) letöltés a meglévő downloaderrel
    let buf;
    try {
      buf = await downloadFile(url);
    } catch (err) {
      console.error('[API] /api/feed/headers letöltési hiba:', err?.message || err);
      return res.status(502).json({ error: 'Feed letöltése sikertelen', details: err?.message || err });
    }

    // 2) parse – univerzális parserrel
    let rows;
    try {
      rows = await parseData(buf, { feedUrl: url });
    } catch (err) {
      console.error('[API] /api/feed/headers parse hiba:', err?.message || err);
      return res.status(422).json({ error: 'Feed feldolgozása sikertelen', details: err?.message || err });
    }

    // 3) fejlécek = első sor kulcsai
    const header = Array.isArray(rows) && rows.length ? Object.keys(rows[0]) : [];

    // 4) normalizált válasz a frontendnek
    const fields = (header || [])
      .map((h) => ({ key: h, label: String(h).trim() }))
      .filter((f) => f.label);
    res.json({ count: fields.length, fields });
    console.log('[API] /api/feed/headers', {
      url,
      count: fields.length,
      sample: fields.slice(0, 3),
    });
  } catch (e) {
    console.error('[GET /api/feed/headers] error:', e);
    res.status(500).json({ error: e.message || 'Ismeretlen hiba', details: e });
  }
};
