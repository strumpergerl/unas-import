const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const UNAS_API_URL = process.env.UNAS_API_URL;

/**
 * Feltölti az adatokat az Unas API-ra vagy naplózza, ha dryRun mód van.
 * @param {Array<object>} records - Átalakított rekordok.
 * @param {object} processConfig - A `processes.json`-beli konfiguráció egy eleme.
 * @param {object} shopConfig - A `shops.json`-beli webshop konfiguráció.
 * @returns {Promise<void>}
 */
async function uploadToUnas(records, processConfig, shopConfig) {
  const { shopId, dryRun } = processConfig;
  const apiKey = shopConfig.apiKey;
  const endpoint = `${UNAS_API_URL}/shops/${shopId}/products`;

  if (dryRun) {
    console.log(`DRY RUN: Uploading ${records.length} items to ${endpoint}`);
    console.dir(records, { depth: null });
    return;
  }

  try {
    const response = await axios.post(endpoint, { items: records }, {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });
    console.log(`Uploaded ${records.length} items. Status: ${response.status}`);
  } catch (error) {
    console.error('Error uploading to Unas:', error.response ? error.response.data : error.message);
    throw error;
  }
}

module.exports = uploadToUnas;