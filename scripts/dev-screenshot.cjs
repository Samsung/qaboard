// Screenshots of the development server's pages (scripts/dev.py), signed in as its admin, with the page's errors.
//   node scripts/dev-screenshot.cjs <url or path> [out.png] [--width 1600] [--height 1000] [--full] [--anonymous] [--wait 3000]
//   node scripts/dev-screenshot.cjs /dev/image-pipeline/commits .dev/shots/commits.png
// Paths are relative to the web app (http://localhost:3000). --full: the whole page, not only the viewport.
// --wait: ms after the network is idle (charts, images). The first page after `up` takes ~20 s: Vite compiles the app.
// Needs Playwright: preinstalled in cloud containers, else `npm install` in webapp/ and `npx playwright install chromium`.
const fs = require('fs')
const path = require('path')
let playwright
try { playwright = require('playwright') } catch {
  try { playwright = require(path.join(__dirname, '..', 'webapp', 'node_modules', 'playwright')) } catch {
    console.error('Needs Playwright: npm i -g playwright, or `npm install` in webapp/'); process.exit(1)
  }
}

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const value = args[i + 1]
  args.splice(i, 2)
  return value
}
const flag = name => { const i = args.indexOf(`--${name}`); if (i >= 0) args.splice(i, 1); return i >= 0 }
const width = Number(option('width', 1600))
const height = Number(option('height', 1000))
const wait = Number(option('wait', 3000))
const anonymous = flag('anonymous')
const full = flag('full')
const root = path.join(__dirname, '..')
const state = JSON.parse(fs.readFileSync(path.join(process.env.QABOARD_DEV_DIR || path.join(root, '.dev'), 'state.json'), 'utf8'))
const web = `http://localhost:${state.ports.web}`
const [target = '/', out = path.join(root, '.dev', 'shots', 'page.png')] = args
const url = target.startsWith('http') ? target : `${web}${target.startsWith('/') ? '' : '/'}${target}`

;(async () => {
  const browser = await playwright.chromium.launch()
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })
  // the "What's new" popup would cover the page (it's off with `npm start`, on in production builds)
  await context.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'))
  if (!anonymous) {
    const response = await context.request.post(`${web}/api/v1/user/auth/`, {
      form: { username: 'admin', password: 'qaboard-dev' }, headers: { Origin: web },
    })
    if (!response.ok()) console.error(`sign in failed: HTTP ${response.status()} ${await response.text()}`)
  }
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`) })
  page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`) })
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => errors.push(`goto: ${e.message}`))
  // until the page stops showing spinners and skeletons (Blueprint's), e.g. while Vite compiles the app's chunks
  // for 2 s in a row: lazy chunks and viewers show theirs only once the previous ones loaded
  const loading = () => page.evaluate(() => !!document.querySelector('.bp6-spinner, .bp6-skeleton, [aria-busy="true"]'))
  const deadline = Date.now() + 90000
  let calm = 0
  while (calm < 4 && Date.now() < deadline) {
    await page.waitForTimeout(500)
    calm = (await loading().catch(() => true)) ? 0 : calm + 1
  }
  if (calm < 4) errors.push('still loading after 90 s (spinners or skeletons on the page)')
  await page.waitForTimeout(wait)
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  await page.screenshot({ path: out, fullPage: full })
  console.log(`${url}\n  -> ${path.resolve(out)}`)
  // what the development server lacks: an IIIF image server (the viewer then loads the image itself), and maybe the
  // network to reach gravatar.com (avatars). Browsers log each failed request again as a console error.
  const expected = e => /\/iiif\/|\/api\/v1\/git\/proxy|^console: Failed to load resource/.test(e)
  const unique = [...new Set(errors)]
  for (const e of unique.filter(e => !expected(e)).slice(0, 20)) console.log(`  ${e}`)
  const skipped = unique.filter(expected).length
  if (skipped) console.log(`  (${skipped} expected errors hidden: /iiif/ 404s, avatars, and their console lines)`)
  await browser.close()
})()
