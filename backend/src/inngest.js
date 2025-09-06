const { Inngest } = require("inngest");

const inngest = new Inngest({
  name: "unas-import",
  eventKey: process.env.INNGEST_EVENT_KEY, // vagy közvetlenül az API kulcs
});

module.exports = inngest;