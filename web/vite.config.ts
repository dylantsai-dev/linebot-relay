import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'

// The console is served by server.js at /console, so assets live under /console/.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.RELAY_BACKEND || 'https://linebot.dylantsai.com'
  const proxy = Object.fromEntries(
    ['/api', '/webhook', '/health', '/sessions'].map(route => [route, { target, changeOrigin: true, secure: true }]),
  )
  return {
    base: '/console/',
    plugins: [vue()],
    server: { host: '0.0.0.0', port: 5173, strictPort: true, proxy },
    preview: { port: 4173, proxy },
    build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 400 },
  }
})
