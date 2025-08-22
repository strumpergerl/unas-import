// backend/src/core/parseData.js
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');
const xml2js = require('xml2js');

function parseXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheets = wb.SheetNames || [];
  for (const name of sheets) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (Array.isArray(rows) && rows.length) {
      console.log(`[PARSE] XLSX sheet="${name}" rows=${rows.length}`);
      return rows;
    }
  }
  console.warn('[PARSE] XLSX: minden sheet üresnek tűnik');
  return [];
}

async function parseXml(buffer) {
  const text = buffer.toString('utf8');
  const parser = new xml2js.Parser({ explicitArray: false });
  const doc = await parser.parseStringPromise(text);

  // Tipikus utak (állítsd a feededhez):
  // Próbáljuk sorban, ahol tömb lehet a rekordlista
  const candidates = [
    doc?.items?.item,
    doc?.Items?.Item,
    doc?.products?.product,
    doc?.Products?.Product,
    doc?.feed?.entry,
  ];
  const firstArr = candidates.find(x => Array.isArray(x));
  if (firstArr) return firstArr;

  // Ha egyetlen elem, csomagoljuk tömbbe
  const firstOne = candidates.find(x => x && typeof x === 'object');
  if (firstOne) return [firstOne];

  console.warn('[PARSE] XML: nem találtunk rekordlistát, üres tömböt adunk vissza');
  return [];
}

async function parseData(buffer, processConfig) {
  const url = (processConfig.feedUrl || '').toLowerCase();
  const ext = (url.match(/\.([a-z0-9]+)(\?.*)?$/) || [])[1] || '';

  if (ext === 'xlsx' || ext === 'xls') {
    return parseXlsx(buffer);
  } else if (ext === 'csv') {
    const text = buffer.toString('utf8');
    return parse(text, { columns: true, skip_empty_lines: true });
  } else if (ext === 'xml') {
    return parseXml(buffer);
  }

  throw new Error(`Unsupported extension: ${ext}`);
}

module.exports = parseData;