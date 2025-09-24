// backend/src/core/transformData.js

// Minimal normalization: field mapping, type conversion, and orderable calculation only
async function transformData(records, processConfig) {
  const {
    fieldMapping,
    stockThreshold = 1,
    priceFields = {},
    stockFields = {},
    weightFields = {}, 
  } = processConfig;

  return records.map((record) => {
    const transformed = {};

    // 1) Field mapping (kivéve a price/stock/weight feed mezőket)
    for (const [srcKey, dstKey] of Object.entries(fieldMapping)) {
      if (
        srcKey === priceFields.feed ||
        srcKey === stockFields.feed ||
        srcKey === weightFields.feed 
      ) {
        continue;
      }
      const dst = String(dstKey || '');
      transformed[dst] = record[srcKey];
    }

    // 2) Price mező explicit másolása, ha létezik (eredeti feed kulcson)
    if (priceFields.feed && Object.prototype.hasOwnProperty.call(record, priceFields.feed)) {
      transformed[priceFields.feed] = record[priceFields.feed];
    }

    // 3) Stock mező explicit másolása, ha létezik (eredeti feed kulcson)
    if (stockFields.feed && Object.prototype.hasOwnProperty.call(record, stockFields.feed)) {
      transformed[stockFields.feed] = record[stockFields.feed];
    }

    // 4) Weight mező explicit másolása, ha létezik (eredeti feed kulcson) 
    if (weightFields.feed && Object.prototype.hasOwnProperty.call(record, weightFields.feed)) {
      transformed[weightFields.feed] = record[weightFields.feed];
    }

    // 5) orderable számítása stockFields.feed alapján (marad, ahogy volt)
    const stockSrcKey = stockFields.feed;
    if (stockSrcKey) {
      const raw = record[stockSrcKey];
      let feedStock = 0;
      if (raw !== undefined && raw !== null && raw !== '') {
        const cleaned = String(raw).replace(',', '.').replace(/[^0-9.\-]/g, '').trim();
        const n = Number(cleaned);
        feedStock = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
      }
      transformed.orderable = Number.isFinite(stockThreshold) && feedStock >= stockThreshold ? 1 : 0;
    }

    return transformed;
  });
}

module.exports = transformData;
