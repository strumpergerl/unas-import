const { Inngest } = require("inngest");
const { serve } = require('inngest/express');

const inngest = new Inngest({
    id: "unas-import", // vagy appId, de id legyen!
    name: "unas-import",
    //eventKey: process.env.INNGEST_EVENT_KEY, // vagy közvetlenül az API kulcs
});

const functions = [
    
];

module.exports = serve({ client: inngest, functions });