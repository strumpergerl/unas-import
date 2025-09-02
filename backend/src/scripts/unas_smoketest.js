// backend/src/scripts/unas_smoketest.js
require('../bootstrapEnv');
const axios = require('axios');
const xml2js = require('xml2js');

// --- CLI argok
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ''), true];
  })
);

// --- BASE normalizálás (defenzív)
const RAW_BASE = String(args.base || process.env.UNAS_API_URL || 'https://api.unas.eu/shop').replace(/\/+$/, '');
const BASE = RAW_BASE.replace(/\/shop\/[^/]+$/i, '/shop');

const API_KEY = 'adf156708336e8897b85b661bcd93294fe2eda73';
const SHOP_ID = 'shop3';

if (!API_KEY) {
  console.error('[FAIL] Adj meg API kulcsot: --key="..."  (vagy UNAS_API_KEY ENV)');
  process.exit(1);
}

(async () => {
  console.log('[DIAG] BASE =', BASE);

  // 1) LOGIN + WebshopInfo
  const builder = new xml2js.Builder({ headless: true });
  const loginXml = `<?xml version="1.0" encoding="UTF-8"?>\n${builder.buildObject({
    Login: { ApiKey: API_KEY, WebshopInfo: 'true' }
  })}`;

  const loginResp = await axios.post(`${BASE}/login`, loginXml, {
    headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
    validateStatus: () => true,
    timeout: 15000,
  });

  console.log('[DIAG] LOGIN status =', loginResp.status);
  if (loginResp.status !== 200) {
    console.error('[FAIL] LOGIN sikertelen. Body:', String(loginResp.data).slice(0, 300));
    process.exit(2);
  }

  const parser = new xml2js.Parser({ explicitArray: false });
  const parsed = await parser.parseStringPromise(loginResp.data);
  const token = parsed?.Login?.Token || parsed?.LoginResponse?.Token;
  const expire = parsed?.Login?.Expire || parsed?.LoginResponse?.Expire;
  console.log('[OK] Token megszerezve. Expires:', expire || '(ismeretlen)');

  // Webshopok kigyűjtése (különböző válasz-sémákra felkészülve)
  const rawWebshops =
    parsed?.Login?.Webshops?.Webshop ||
    parsed?.Login?.Webshop ||
    parsed?.Webshops?.Webshop ||
    parsed?.Webshops ||
    [];
  const list = Array.isArray(rawWebshops) ? rawWebshops : [rawWebshops].filter(Boolean);

  // Próbáljuk minél biztosabban kinyerni az azonosítót (Id / ShopId / ID / Name fallback)
  const shops = list
    .map(w => {
      const id =
        w?.Id || w?.ID || w?.ShopId || w?.ShopID || w?.shopId || w?.shopID || w?.id;
      const name = w?.Name || w?.ShopName || w?.name || w?.shopName;
      return { id: id ? String(id).trim() : null, name: name ? String(name).trim() : null, raw: w };
    })
    .filter(s => s.id);

  if (!shops.length) {
    console.error('[FAIL] A login válasz nem tartalmazott webshop azonosítót. Nyers:', JSON.stringify(parsed, null, 2).slice(0, 800));
    process.exit(3);
  }

  console.log('[DIAG] Webshops azonosítók:');
  shops.forEach(s => console.log(`  - id="${s.id}"  name="${s.name || ''}"`));

  const targets = ONLY_SHOP ? shops.filter(s => s.id === ONLY_SHOP) : shops;
  if (!targets.length) {
    console.error(`[FAIL] Az --only="${SHOP_ID}" nem egyezik egyetlen visszaadott shop id-val sem.`);
    process.exit(4);
  }

  // 2) Minden visszaadott shop-ra megpróbáljuk a getProductDB-t
  for (const s of targets) {
    const genUrl = `${BASE}/${s.id}/getProductDB`;
    console.log(`\n[TRY] getProductDB generálás: shopId="${s.id}" (${s.name || 'n/a'})`);
    let genResp;
    let methodUsed = 'GET';

    // 2/a) próbáld GET-tel
    genResp = await axios.get(genUrl, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
      timeout: 20000,
    });

    // 400/405/415 esetén próbáld POST + XML-lel
    if (![200].includes(genResp.status)) {
      methodUsed = 'POST<GetProductDB/>';
      const requestXml = `<?xml version="1.0" encoding="UTF-8"?><GetProductDB/>`;
      genResp = await axios.post(genUrl, requestXml, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/xml; charset=UTF-8' },
        validateStatus: () => true,
        timeout: 20000,
      });
    }

    console.log(`[DIAG] getProductDB status = ${genResp.status} (method: ${methodUsed})`);
    if (genResp.status !== 200) {
      console.error('[FAIL] getProductDB generálás hibás. Body:', String(genResp.data).slice(0, 300));
      continue;
    }

    // 3) XML-ből Link/Url kinyerése
    const txt = String(genResp.data || '');
    const m = txt.match(/<Link>([^<]+)<\/Link>/i) || txt.match(/<Url>([^<]+)<\/Url>/i);
    if (!m) {
      console.error('[FAIL] Nincs Link/Url az XML-ben. XML (első 500 char):', txt.slice(0, 500));
      continue;
    }
    const downloadUrl = m[1];
    console.log('[DIAG] CSV URL:', downloadUrl);

    // 4) CSV letöltés
    const csvResp = await axios.get(downloadUrl, {
      validateStatus: () => true,
      timeout: 30000,
      responseType: 'arraybuffer',
    });
    console.log('[DIAG] CSV download status =', csvResp.status);
    if (csvResp.status !== 200) {
      console.error('[FAIL] CSV letöltés hibás. Body:', Buffer.from(csvResp.data || '').toString('utf8').slice(0, 300));
      continue;
    }

    // Ha idáig eljutott, akkor ez a shop működik
    console.log('[OK] ProductDB letöltés sikeres ehhez a shophoz.');
  }

  console.log('\n[KÉSZ] Smoketest lefutott.');
})().catch(e => {
  console.error('[FATAL]', e?.message || e);
  process.exit(9);
});
