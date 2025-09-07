const { Inngest } = require("inngest");

const inngest = new Inngest({
    id: "unas-import", // vagy appId, de id legyen!
    name: "unas-import",
    //eventKey: process.env.INNGEST_EVENT_KEY, // vagy közvetlenül az API kulcs
});

module.exports = inngest;