// backend/src/core/transformData.js

// Minimal normalization: field mapping, type conversion, and orderable calculation only
async function transformData(records, processConfig) {
	const { fieldMapping, stockThreshold = 1 } = processConfig;

	return records.map((record) => {
		const transformed = {};
		// 1) Field mapping (except price/stock)
		for (const [srcKey, dstKey] of Object.entries(fieldMapping)) {
			const dst = String(dstKey || '');
			if (dst === 'price' || dst === 'stock') continue;
			transformed[dst] = record[srcKey];
		}

		// 2) Stock normalization + orderable
		const stockSrcKey = Object.entries(fieldMapping).find(([, dst]) => {
			const v = String(dst || '').toLowerCase();
			return v === 'stock' || v.includes('stock') || v.includes('készlet') || v.includes('quantity') || v === 'qty';
		})?.[0];

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
