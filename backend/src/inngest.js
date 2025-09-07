const { Inngest } = require("inngest");
const { serve } = require('inngest/express');
const { runProcessById } = require("./runner");

const inngest = new Inngest({
        id: "unas-import", // vagy appId, de id legyen!
        name: "unas-import",
        //eventKey: process.env.INNGEST_EVENT_KEY, // vagy közvetlenül az API kulcs
});

// Inngest function: process futtatása event alapján
const runProcessFunction = inngest.createFunction(
    { id: "run-process" },
    { event: "unas/process.run" },
    async ({ event, step }) => {
        const processId = event.data?.processId;
        if (!processId) throw new Error("processId missing in event data");
        await step.run("run-process", async () => {
            await runProcessById(processId);
        });
        return { ok: true };
    }
);

const functions = [
    runProcessFunction
];

module.exports = serve({ client: inngest, functions });