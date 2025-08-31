// frontend/vite.config.js
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'url'
import { dirname, resolve } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const isCI = process.env.CI === 'true'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.VITE_API_URL || 'http://localhost:3000/api'
    }
  },
  base: './',
  build: {
    outDir: isCI ? 'dist' : resolve(__dirname, '../backend/public'),
    emptyOutDir: true
  }
})
