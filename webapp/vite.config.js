/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import { defineConfig, searchForWorkspaceRoot } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { visualizer } from 'rollup-plugin-visualizer'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { releaseNotes } from './releaseNotes.js'

// The JSON schemas of qaboard.yaml and the batch files, shared with the `qa` package and the docs website
const schemas = fileURLToPath(new URL('../qaboard/schemas', import.meta.url))

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

// Sentry's release: the version of the image, e.g. the commit it was built from (see Dockerfile)
const release = process.env.QABOARD_VERSION || process.env.SENTRY_RELEASE || null
// With a token, the build uploads the source maps to Sentry (for readable stack traces), then deletes them
// so that they're not served. SENTRY_ORG, SENTRY_PROJECT and, for a self-hosted Sentry, SENTRY_URL say where.
const sentry_upload = !!process.env.SENTRY_AUTH_TOKEN
const sentry = () => sentry_upload && sentryVitePlugin({
  authToken: process.env.SENTRY_AUTH_TOKEN,
  org: process.env.SENTRY_ORG || undefined,
  project: process.env.SENTRY_PROJECT || undefined,
  url: process.env.SENTRY_URL || undefined,
  // Don't report the plugin's own errors and usage to sentry.io
  telemetry: false,
  release: {
    name: release ?? undefined,
    // The SDK gets the release from import.meta.env.QABOARD_RELEASE
    inject: false,
    // There is no git checkout in the docker build
    setCommits: false,
  },
  sourcemaps: { filesToDeleteAfterUpload: ['./build/**/*.map'] },
  // A Sentry server that's down or misconfigured doesn't fail the build: we only lose readable stack traces
  errorHandler: err => console.warn(`WARNING: could not upload the source maps to Sentry: ${err}`),
})

const compiler_logger = {
  logEvent(filename, event) {
    if (event.kind === 'CompileError' || event.kind === 'CompileSkip')
      console.log(`[react-compiler] ${event.kind} ${filename}:${event.fnLoc?.start?.line ?? ''} ${event.detail?.reason ?? event.reason ?? ''}`)
  },
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
    // Automatic memoization of components and hooks https://react.dev/learn/react-compiler
    // Components that break the Rules of React are skipped: `REACT_COMPILER_LOG=1 npm run build` lists them.
    babel({ presets: [reactCompilerPreset({ logger: process.env.REACT_COMPILER_LOG ? compiler_logger : undefined })] }),
    fileBrowser(),
    // the release notes, from website/release-notes/
    releaseNotes(),
    // npm run analyze => build/stats.html
    mode === 'analyze' && visualizer({ filename: 'build/stats.html', gzipSize: true }),
    // Last, to upload the final source maps
    sentry(),
  ],
  resolve: { alias: { 'qaboard-schemas': schemas } },
  define: {
    // Not in the tests: they'd depend on the shell's environment (e.g. QABOARD_VERSION set by an .envrc)
    'import.meta.env.QABOARD_RELEASE': JSON.stringify(mode === 'test' ? '' : release ?? ''),
  },
  server: {
    port: 3000,
    strictPort: true,
    host: process.env.HOST,
    // In docker the app is reached via the container's hostname
    allowedHosts: process.env.DANGEROUSLY_DISABLE_HOST_CHECK === 'true' ? true : undefined,
    watch: { usePolling: process.env.CHOKIDAR_USEPOLLING === 'true' },
    proxy,
    // the schemas are outside of webapp/
    fs: { allow: [searchForWorkspaceRoot(process.cwd()), schemas] },
  },
  preview: { port: 3000, proxy },
  build: {
    // nginx serves this folder, see Dockerfile
    outDir: 'build',
    // When we upload them to Sentry, the bundles don't link to the source maps, that we delete
    sourcemap: sentry_upload ? 'hidden' : true,
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
    include: ['src/**/*.test.{js,jsx,ts,tsx}'],
    globals: true,
    setupFiles: ['./src/setupTests.js'],
    reporters: process.env.CI ? ['default', 'junit'] : ['default'],
    outputFile: { junit: 'junit.xml' },
    coverage: {
      provider: 'v8',
      // not the markdown, css, json... files in src/: they can't be parsed as code
      include: ['src/**/*.{js,jsx,ts,tsx}'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.{js,jsx,ts,tsx}'],
      reporter: ['text-summary', 'cobertura'],
    },
  },
}))
