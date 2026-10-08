/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'
import { releaseNotes } from './releaseNotes.js'

// Where the development server relays API/data requests. The variable names predate Vite, we keep them.
// By default we assume you run QA-Board on localhost
const QABOARD_SERVER_URL = process.env.REACT_APP_QABOARD_HOST || 'http://localhost:5151'
// the api server doesn't serve the static content
const QABOARD_API_HOST = process.env.REACT_APP_QABOARD_API_HOST || QABOARD_SERVER_URL

const proxy = {
  '^/api/': { target: QABOARD_API_HOST, changeOrigin: true },
  '^/s/': { target: QABOARD_SERVER_URL, changeOrigin: true },
  '^/iiif/': { target: QABOARD_SERVER_URL, changeOrigin: true },
  '^/docs/': { target: QABOARD_SERVER_URL, changeOrigin: true },
}

// In production nginx serves files.html for the folders under /s/ (services/nginx/snippets/qaboard-files.conf),
// we do the same here, so the file browser can be developed with `npm start`
const fileBrowser = () => {
  const middleware = (req, res, next) => {
    const [pathname, search = ''] = req.url.split('?')
    const isFolder = pathname.startsWith('/s/') && pathname.endsWith('/')
    if (isFolder && (req.headers.accept ?? '').includes('text/html') && !new URLSearchParams(search).has('view'))
      req.url = '/files.html'
    next()
  }
  return {
    name: 'qaboard-file-browser',
    configureServer: server => { server.middlewares.use(middleware) },
    configurePreviewServer: server => { server.middlewares.use(middleware) },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    fileBrowser(),
    // the release notes, from website/release-notes/
    releaseNotes(),
    // npm run analyze => build/stats.html
    mode === 'analyze' && visualizer({ filename: 'build/stats.html', gzipSize: true }),
  ],
  server: {
    port: 3000,
    strictPort: true,
    host: process.env.HOST,
    // In docker the app is reached via the container's hostname
    allowedHosts: process.env.DANGEROUSLY_DISABLE_HOST_CHECK === 'true' ? true : undefined,
    watch: { usePolling: process.env.CHOKIDAR_USEPOLLING === 'true' },
    proxy,
  },
  preview: { port: 3000, proxy },
  build: {
    // nginx serves this folder, see Dockerfile
    outDir: 'build',
    sourcemap: true,
    // plotly, monaco and three are big but lazy-loaded
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      input: {
        main: 'index.html',
        // the file browser, see src/files/
        files: 'files.html',
      },
    },
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    // e2e/ has the playwright tests
    include: ['src/**/*.test.{js,jsx}'],
    globals: true,
    setupFiles: ['./src/setupTests.js'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'junit.xml' },
    coverage: {
      provider: 'v8',
      // not the markdown, css, json... files in src/: they can't be parsed as code
      include: ['src/**/*.{js,jsx,ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.{js,jsx}'],
      reporter: ['text-summary', 'cobertura'],
    },
  },
}))
