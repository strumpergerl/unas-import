// vite.config.js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.VITE_API_URL
    }
  },
  base: './',
  build: {
    // a build kimenete a backend public mappájába kerül
    outDir: resolve(__dirname, '../backend/public'),
    emptyOutDir: true
  }
})