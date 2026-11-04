import { defineConfig, loadEnv } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

// src/brand/mark.svg is the single source for the app mark: BrandMark.vue inlines it and this plugin
// serves/emits it as /console/favicon.svg. PNG fallbacks in public/ come from scripts/render-icons.py.
const markFile = fileURLToPath(new URL('./src/brand/mark.svg', import.meta.url))
function favicon(): Plugin {
  return {
    name: 'relay-favicon',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/console/favicon.svg') return next()
        res.setHeader('Content-Type', 'image/svg+xml')
        res.setHeader('Cache-Control', 'no-cache')
        res.end(readFileSync(markFile))
      })
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: readFileSync(markFile, 'utf8') })
    },
  }
}

// The console is served by server.js at /console, so assets live under /console/.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.RELAY_BACKEND || 'http://127.0.0.1:8790'
  const proxy = Object.fromEntries(
    ['/api', '/webhook', '/health', '/sessions'].map(route => [route, { target, changeOrigin: true, secure: true }]),
  )
  return {
    base: '/console/',
    plugins: [vue(), favicon()],
    server: { host: '0.0.0.0', port: 5173, strictPort: true, proxy },
    preview: { port: 4173, proxy },
    build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, chunkSizeWarningLimit: 400 },
  }
})
