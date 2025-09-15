const { Inngest } = require("inngest");
const { serve } = require('inngest/express');
const { runProcessById, pruneOldRuns } = require("./runner");
const { db } = require("./db/firestore");

const inngest = new Inngest({
    id: "unas-import", // vagy appId, de id legyen!
    name: "unas-import",
    //eventKey: process.env.INNGEST_EVENT_KEY, // vagy közvetlenül az API kulcs
});

// Dinamikus scheduler: 5 percenként ellenőrzi az összes aktív process-t
const dynamicSchedulerFunction = inngest.createFunction(
    { id: "dynamic-scheduler" },
    { cron: "*/5 * * * *" }, // 5 percenként
    async ({ step }) => {
        const now = new Date();
        // Lekérjük az összes aktív process-t
        const snap = await db.collection("processes").get();
        const results = [];
            for (const doc of snap.docs) {
                const data = doc.data();
                const processId = doc.id;
                if (!data.nextRunAt) continue;
                const nextRun = new Date(data.nextRunAt);
                if (isNaN(nextRun.getTime())) continue;
                if (nextRun <= now) {
                    // Itt futtatjuk a process-t
                    try {
                        await step.run(`run-process-${processId}`, async () => {
                            await runProcessById(processId);
                        });
                        // nextRunAt frissítése a frequency alapján
                        let intervalMs = 0;
                        if (data.frequency && typeof data.frequency === 'string') {
                            const m = data.frequency.trim().toLowerCase().match(/^(\d+)\s*([smhd])$/);
                            if (m) {
                                const n = parseInt(m[1], 10);
                                const mult = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[m[2]];
                                if (n > 0 && mult) intervalMs = n * mult;
                            }
                        }
                        if (intervalMs > 0) {
                            const newNextRun = new Date(nextRun.getTime() + intervalMs);
                            await doc.ref.update({ nextRunAt: newNextRun.toISOString() });
                        }
                        results.push({ processId, status: "ok" });
                    } catch (e) {
                        results.push({ processId, status: "error", error: e?.message || e });
                    }
                }
            }
            return { ran: results };
        }
    );


// Napi prune function: minden nap 03:30-kor törli a 30 napnál régebbi logokat
const dailyPruneFunction = inngest.createFunction(
    { id: "daily-prune" },
    { cron: "30 3 * * *" }, // minden nap 03:30
    async ({ step }) => {
        try {
            const deleted = await step.run("prune-old-runs", async () => {
                return await pruneOldRuns(30);
            });
            return { ok: true, deleted };
        } catch (e) {
            return { ok: false, error: e?.message || e };
        }
    }
);

const functions = [
    dynamicSchedulerFunction,
    dailyPruneFunction
];

module.exports = serve({ client: inngest, functions });