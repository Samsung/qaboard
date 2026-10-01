/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'

// Where the development server relays API/data requests. The variable names predate Vite, we keep them.
// By default we assume you run QA-Board on localhost
const QABOARD_SERVER_URL = process.env.REACT_APP_QABOARD_HOST || 'http://localhost:5151'
// the api server doesn't serve the static content
const QABOARD_API_HOST = process.env.REACT_APP_QABOARD_API_HOST || QABOARD_SERVER_URL

const proxy = {
  '^/api/': { target: QABOARD_API_HOST, changeOrigin: true },
  '^/s/': { target: QABOARD_SERVER_URL, changeOrigin: true },
  '^/iiif/': { target: QABOARD_SERVER_URL, changeOrigin: true },
}

export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
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
  },
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/setupTests.js'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'junit.xml' },
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'cobertura'],
    },
  },
}))
