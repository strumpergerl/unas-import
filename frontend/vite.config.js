import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000'
    }
  },
  base: './',
  build: {
    // a build kimenete a backend public mappájába kerül
    outDir: path.resolve(__dirname, '../backend/public'),
    emptyOutDir: true
  }
})