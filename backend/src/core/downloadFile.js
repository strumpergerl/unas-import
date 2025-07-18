const axios = require('axios');

/**
 * Letölt egy fájlt a megadott URL-ről.
 * @param {string} url - A fájl elérési útja.
 * @returns {Promise<Buffer>} - A letöltött fájl tartalma Buffer-ben.
 */
async function downloadFile(url) {
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  return Buffer.from(response.data);
}

module.exports = downloadFile;