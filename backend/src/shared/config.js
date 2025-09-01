// backend/src/shared/config.js
require('../bootstrapEnv');
const axios = require('axios');

const NODE_ENV = process.env.NODE_ENV || 'development';

// UNAS
const RAW_UNAS_BASE = (process.env.UNAS_API_URL || 'https://api.unas.eu/shop').replace(/\/+$/, '');
const UNAS_BASE = RAW_UNAS_BASE.replace(/\/shop\/[^/]+$/i, '/shop');

const UNAS_TIMEOUT_MS = Number(process.env.UNAS_TIMEOUT_MS ?? 120000);
const UNAS_DOWNLOAD_TIMEOUT_MS = Number(process.env.UNAS_DOWNLOAD_TIMEOUT_MS ?? 120000);

// Axios példányok
const http = axios.create({
  timeout: UNAS_TIMEOUT_MS,
  validateStatus: s => s >= 200 && s < 500,
});

module.exports = {
  NODE_ENV,
  UNAS_BASE,
  UNAS_TIMEOUT_MS,
  UNAS_DOWNLOAD_TIMEOUT_MS,
  http,
};
