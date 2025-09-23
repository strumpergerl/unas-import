import { ref, onMounted, onBeforeUnmount } from 'vue';
import { db } from '@/firebase';
import {
	collection,
	query as q,
	orderBy,
	limit as qLimit,
	where,
	onSnapshot,
	startAfter,
	getDocs,
} from 'firebase/firestore';

export function useFirestoreList({
	path,
	order,
	dir = 'desc',
	lim = 100,
	whereCond = null,
}) {
	const items = ref([]);
	const loading = ref(true);
	const error = ref(null);
	const hasMore = ref(false);
	let lastDoc = null;
	let stop = null;

	function toPlain(doc) {
		const data = doc.data();
		// Firestore Timestamp → ISO string (ha Timestamp)
		const normalizeTime = (v) => {
			if (!v) return v;
			if (typeof v?.toDate === 'function') return v.toDate().toISOString();
			return v; // ha már string/number
		};
		// Futásnaplókban jellemző mezők normalizálása (nem alakítjuk át az egyéb mezőket!)
		if (data.startedAt) data.startedAt = normalizeTime(data.startedAt);
		if (data.finishedAt) data.finishedAt = normalizeTime(data.finishedAt);
		return { id: doc.id, ...data };
	}

	onMounted(() => {
		try {
			const col = collection(db, path);
			const parts = [];
			if (whereCond) parts.push(where(...whereCond)); // pl. ['shopId', '==', '...']
			if (order) parts.push(orderBy(order, dir));
			if (lim) parts.push(qLimit(lim));
			const qq = q(col, ...parts);

			stop = onSnapshot(
				qq,
				(snap) => {
					items.value = snap.docs.map(toPlain);
					lastDoc = snap.docs[snap.docs.length - 1] || null;
					hasMore.value = !!lastDoc;
					loading.value = false;
				},
				(err) => {
					error.value = err;
					loading.value = false;
				}
			);
		} catch (e) {
			error.value = e;
			loading.value = false;
		}
	});

	async function loadMore() {
		if (!lastDoc) return;
		const col = collection(db, path);
		const parts = [];
		if (whereCond) parts.push(where(...whereCond));
		if (order) parts.push(orderBy(order, dir));
		if (lim) parts.push(qLimit(lim));
		const nextQ = q(col, ...parts, startAfter(lastDoc));
		const snap = await getDocs(nextQ);
		const more = snap.docs.map(toPlain);
		items.value = items.value.concat(more);
		lastDoc = snap.docs[snap.docs.length - 1] || lastDoc;
		hasMore.value = snap.docs.length === lim;
	}

	onBeforeUnmount(() => {
		if (typeof stop === 'function') stop();
	});

	return { items, loading, error, hasMore, loadMore };
}
