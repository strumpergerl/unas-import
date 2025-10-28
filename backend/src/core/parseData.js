// backend/src/core/parseData.js
const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');
const xml2js = require('xml2js');

const LINE_BREAK_REGEX = /[\r\n]+/g;

const isPlainObject = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const stripLineBreaks = (text) => {
  if (typeof text !== 'string') return text;
  return text.includes('\n') || text.includes('\r')
    ? text.replace(LINE_BREAK_REGEX, ' ')
    : text;
};

const sanitizeValue = (value) => {
  if (typeof value === 'string') {
    return stripLineBreaks(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = sanitizeValue(val);
    }
    return out;
  }
  return value;
};

const sanitizeRecords = (rows) => {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => sanitizeValue(row));
};

const detectDelimiter = (line) => {
  if (typeof line !== 'string' || line.length === 0) return ',';
  const counts = {
    ';': (line.match(/;/g) || []).length,
    ',': (line.match(/,/g) || []).length,
    '\t': (line.match(/\t/g) || []).length,
  };
  const [best] =
    Object.entries(counts).sort((a, b) => {
      if (a[1] === b[1]) return a[0].charCodeAt(0) - b[0].charCodeAt(0);
      return b[1] - a[1];
    })[0] || [','];
  return counts[best] > 0 ? best : ',';
};

function parseXlsx(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const sheets = wb.SheetNames || [];
  for (const name of sheets) {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    if (Array.isArray(rows) && rows.length) {
      console.log(`[PARSE] XLSX sheet="${name}" rows=${rows.length}`);
      return sanitizeRecords(rows);
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
  if (firstArr) return sanitizeRecords(firstArr);

  // Ha egyetlen elem, csomagoljuk tömbbe
  const firstOne = candidates.find(x => x && typeof x === 'object');
  if (firstOne) return sanitizeRecords([firstOne]);

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
    const firstLine = text.split(/\r?\n/).find((line) => line.trim().length > 0) || '';
    const delimiter = detectDelimiter(firstLine);
    const rows = parse(text, {
      columns: true,
      skip_empty_lines: true,
      delimiter,
      bom: true,
    });
    return sanitizeRecords(rows);
  } else if (ext === 'xml') {
    return parseXml(buffer);
  }

  throw new Error(`Unsupported extension: ${ext}`);
}

module.exports = parseData;
