// backend/src/core/downloadFile.js

const axios = require('axios');

async function downloadFile(feedUrl) {
  if (!feedUrl) throw new Error('downloadFile: feedUrl kötelező');
  const resp = await axios.get(feedUrl, {
    responseType: 'arraybuffer',
    validateStatus: () => true,
  });

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Feed download failed ${resp.status} ${resp.statusText}`);
  }

  const size = resp.data?.byteLength || 0;
  const ctype = resp.headers?.['content-type'] || 'n/a';
  console.log(`[DL] ${feedUrl} -> ${ctype}, ${size} bytes`);

  return Buffer.from(resp.data);
}

module.exports = downloadFile;