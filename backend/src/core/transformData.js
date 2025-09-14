// backend/src/core/transformData.js

// Minimal normalization: field mapping, type conversion, and orderable calculation only
async function transformData(records, processConfig) {
	const { fieldMapping, stockThreshold = 1, priceFields = {}, stockFields = {} } = processConfig;

	return records.map((record) => {
		const transformed = {};
		// 1) Field mapping (except priceFields.feed / stockFields.feed)
		for (const [srcKey, dstKey] of Object.entries(fieldMapping)) {
			// Ha ez a mező a priceFields.feed vagy stockFields.feed, kihagyjuk
			if (srcKey === priceFields.feed || srcKey === stockFields.feed) continue;
			const dst = String(dstKey || '');
			transformed[dst] = record[srcKey];
		}

		// 2) Price mező explicit másolása, ha létezik
		if (priceFields.feed && record.hasOwnProperty(priceFields.feed)) {
			transformed[priceFields.feed] = record[priceFields.feed];
		}
		// 3) Stock mező explicit másolása, ha létezik
		if (stockFields.feed && record.hasOwnProperty(stockFields.feed)) {
			transformed[stockFields.feed] = record[stockFields.feed];
		}

		// orderable számítása stockFields.feed alapján
		const stockSrcKey = stockFields.feed;
		if (stockSrcKey) {
			const raw = record[stockSrcKey];
			let feedStock = 0;
			if (raw !== undefined && raw !== null && raw !== '') {
				const cleaned = String(raw).replace(',', '.').replace(/[^0-9.\-]/g, '').trim();
				const n = Number(cleaned);
				feedStock = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0;
			}
			if (Number.isFinite(stockThreshold) && feedStock >= stockThreshold) {
				transformed.orderable = 1;
			} else {
				transformed.orderable = 0;
			}
		}

		return transformed;
	});
}

module.exports = transformData;
