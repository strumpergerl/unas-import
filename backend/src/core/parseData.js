const XLSX = require('xlsx');
const { parse } = require('csv-parse/sync');
const xml2js = require('xml2js');

/**
 * Feldolgozza a letöltött fájl tartalmát.
 * @param {Buffer} buffer - A fájl tartalma.
 * @param {string} feedUrl - Eredeti URL a kiterjesztés alapján.
 * @returns {Promise<Array<object>>} - A rekordok tömbje.
 */
async function parseData(buffer, feedUrl) {
  const ext = feedUrl.split('.').pop().toLowerCase();

  switch (ext) {
    case 'xlsx':
    case 'xls': {
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheet = workbook.SheetNames[0];
      return XLSX.utils.sheet_to_json(workbook.Sheets[sheet], { raw: false });
    }
    case 'csv': {
      const text = buffer.toString('utf8');
      return parse(text, { columns: true, skip_empty_lines: true });
    }
    case 'xml': {
      const text = buffer.toString('utf8');
      const parser = new xml2js.Parser();
      const result = await parser.parseStringPromise(text);
      // TODO: a pontos útvonal a rekordokig
      return result;
    }
    default:
      throw new Error(`Unsupported extension: ${ext}`);
  }
}

module.exports = parseData;