import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Built files are embedded into the hub binary (cmd/atrium/webdist).
export default defineConfig({
  plugins: [react()],
  build: { outDir: '../cmd/atrium/webdist', emptyOutDir: true, chunkSizeWarningLimit: 900 },
  server: { port: 5199, host: '127.0.0.1', proxy: { '/api': { target: 'http://127.0.0.1:8791', changeOrigin: false } } },
})
