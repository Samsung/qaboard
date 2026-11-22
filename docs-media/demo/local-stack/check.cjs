// Opens the seeded pages in Chromium and takes screenshots (deviceScaleFactor 1), to check the demo by eye.
//   node docs-media/demo/local-stack/check.cjs [out dir]
// Reads the URLs seed.py wrote (<stack>/seeded.json). Prints the page errors and what each page shows.
const fs = require('fs')
const path = require('path')
let playwright
try { playwright = require('playwright') } catch { playwright = require('/opt/node-tools/node_modules/playwright') }

const stack = process.env.QABOARD_LOCAL_STACK || require('path').join(require('os').tmpdir(), 'qaboard-local-stack')
const out = process.argv[2] || path.join(stack, 'shots')
fs.mkdirSync(out, { recursive: true })
const { urls } = JSON.parse(fs.readFileSync(path.join(stack, 'seeded.json'), 'utf8'))

;(async () => {
  const browser = await playwright.chromium.launch()
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 })
  await context.addInitScript(() => localStorage.setItem('qaboard.release-notes.last-seen', '9999-12-31'))
  for (const [name, url] of Object.entries(urls)) {
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))
    page.on('console', m => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 300)}`) })
    page.on('response', r => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`) })
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch(e => errors.push(`goto: ${e.message}`))
    await page.waitForTimeout(4000)
    const file = path.join(out, `${name.replace(/[^a-z0-9]+/gi, '-')}.png`)
    await page.screenshot({ path: file, fullPage: true })
    const text = await page.evaluate(() => document.body.innerText)
    console.log(`\n== ${name}: ${file}`)
    for (const needle of ['Logged series', 'Logged media', 'val/samples', 'denoise/audio', 'predictions', 'weights/conv1', 'answers/prompt-1'])
      console.log(`  ${text.includes(needle) ? 'has' : 'MISSING'} "${needle}"`)
    for (const e of [...new Set(errors)].slice(0, 15)) console.log(`  ${e}`)
    await page.close()
  }
  await browser.close()
})()
