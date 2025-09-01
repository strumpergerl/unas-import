// backend/src/services/feed.js
const axios = require('axios');
const XLSX = require('xlsx');            // npm i xlsx
const { XMLParser } = require('fast-xml-parser'); // npm i fast-xml-parser
const { AppError, BadRequestError } = require('../shared/errors');

const HTTP_TIMEOUT = Number(process.env.FEED_TIMEOUT_MS ?? 120000);
const MAX_BYTES = Number(process.env.FEED_MAX_BYTES ?? 25 * 1024 * 1024); // 25MB

const http = axios.create({
  timeout: HTTP_TIMEOUT,
  maxContentLength: MAX_BYTES,
  maxBodyLength: MAX_BYTES,
  validateStatus: s => s >= 200 && s < 500,
});

function isHttpUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch { return false; }
}

function detectDelimiter(line) {
  const counts = {
    ';': (line.match(/;/g) || []).length,
    ',': (line.match(/,/g) || []).length,
    '\t': (line.match(/\t/g) || []).length,
  };
  return Object.entries(counts).sort((a,b)=>b[1]-a[1])[0][0] || ';';
}

function parseCsvLine(line, delim) {
  const out = []; let cur = ''; let inQ = false;
  for (let i=0;i<line.length;i++){
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i+1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === delim && !inQ) { out.push(cur); cur=''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map(s=>{
    let v = s.trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1,-1);
    return v;
  }).filter(Boolean);
}

function sniffType(url, ct, buf) {
  const low = (ct || '').toLowerCase();
  if (/\bapplication\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet\b/.test(low)) return 'xlsx';
  if (/\btext\/csv\b/.test(low)) return 'csv';
  if (/\bapplication\/xml\b|\btext\/xml\b/.test(low)) return 'xml';
  // kiterjesztés alapján
  if (/\.(xlsx)$/i.test(url)) return 'xlsx';
  if (/\.(csv)$/i.test(url)) return 'csv';
  if (/\.(xml)$/i.test(url)) return 'xml';
  // heurisztika: ha tartalmaz sok '<' → xml; ha null byte nincs és van \n → csv
  const str = buf.toString('utf8', 0, Math.min(buf.length, 2048));
  if (/^\s*</.test(str)) return 'xml';
  return 'csv';
}

function getCsvHeaders(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const firstLine = text.split(/\r?\n/).find(l=>l.trim().length>0) || '';
  const delim = detectDelimiter(firstLine);
  return parseCsvLine(firstLine, delim);
}

function getXlsxHeaders(buf) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return [];
  const sheet = wb.Sheets[sheetName];
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
  const headers = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cellAddr = XLSX.utils.encode_cell({ r: range.s.r, c });
    const cell = sheet[cellAddr];
    const v = (cell && (cell.w || cell.v)) ?? '';
    headers.push(String(v).trim());
  }
  return headers.filter(Boolean);
}

function getXmlHeaders(xmlStr) {
  // Heurisztika: megkeressük az első tömb-szerű listát, és annak első elemének kulcsait
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', allowBooleanAttributes: true });
  const obj = parser.parse(xmlStr);
  function findArrayNode(node) {
    if (!node || typeof node !== 'object') return null;
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') return v[0];
      if (typeof v === 'object') {
        const hit = findArrayNode(v);
        if (hit) return hit;
      }
    }
    return null;
  }
  const firstItem = findArrayNode(obj);
  if (!firstItem) {
    // fallback: első objektum kulcsai
    const firstKey = Object.keys(obj || {})[0];
    const n = obj && obj[firstKey];
    if (n && typeof n === 'object') return Object.keys(n);
    return [];
  }
  return Object.keys(firstItem);
}

async function fetchFeedHeaders(url) {
  if (!isHttpUrl(url)) throw new BadRequestError('Érvénytelen URL (csak http/https)');
  const resp = await http.get(url, { responseType: 'arraybuffer' });
  if (resp.status !== 200) throw new AppError(`Feed letöltés hiba HTTP ${resp.status}`, 'FEED_DL');
  const buf = Buffer.from(resp.data);
  const ct = resp.headers['content-type'] || '';
  const type = sniffType(url, ct, buf);

  try {
    if (type === 'xlsx') return getXlsxHeaders(buf);
    const text = buf.toString('utf8');
    if (type === 'xml')  return getXmlHeaders(text);
    return getCsvHeaders(text);
  } catch (e) {
    throw new AppError(`Fejléc parse hiba (${type}): ${e.message}`, 'FEED_PARSE');
  }
}

module.exports = { fetchFeedHeaders };
