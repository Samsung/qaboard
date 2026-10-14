// Downloads the published media into the build's static files, through HTTPS_PROXY when it's set.
// Keys are content-addressed (shots/<id>/<first 16 hex of the SHA-256>.<ext>): a file is checked against its
// name, cached files are kept, and files the manifest no longer references are removed.
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');

const PARALLEL = 8;
// with backoffs of 1, 2, 4, 8 and 16 s: a build shouldn't fail on a short network outage
const ATTEMPTS = 6;
const TIMEOUT_MS = 60_000;

const env = name => process.env[name] ?? process.env[name.toLowerCase()] ?? '';

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

// NO_PROXY: "*", host names (a leading "." or "*." matches subdomains), IPs and IPv4 CIDRs, with optional ports
function bypassesProxy(url) {
  const noProxy = env('NO_PROXY').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return noProxy.some(rule => {
    if (rule === '*')
      return true;
    let [ruleHost, rulePort] = rule.startsWith('[') ? [rule.slice(1, rule.indexOf(']')), rule.split(']:')[1]] : rule.split(':').length === 2 ? rule.split(':') : [rule, undefined];
    if (rulePort && rulePort !== port)
      return false;
    if (ruleHost.includes('/') && net.isIPv4(host)) {
      const [range, bits] = ruleHost.split('/');
      if (!net.isIPv4(range))
        return false;
      const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      return (ipv4ToInt(range) & mask) === (ipv4ToInt(host) & mask);
    }
    ruleHost = ruleHost.replace(/^\*?\./, '.');
    return ruleHost.startsWith('.') ? host.endsWith(ruleHost) || host === ruleHost.slice(1) : host === ruleHost;
  });
}

function proxyFor(url) {
  const proxy = url.protocol === 'https:' ? env('HTTPS_PROXY') || env('ALL_PROXY') : env('HTTP_PROXY') || env('ALL_PROXY');
  if (!proxy || bypassesProxy(url))
    return null;
  return new URL(/^[a-z]+:\/\//i.test(proxy) ? proxy : `http://${proxy}`);
}

function proxyAuthorization(proxy) {
  if (!proxy.username)
    return {};
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return {'Proxy-Authorization': `Basic ${Buffer.from(credentials).toString('base64')}`};
}

// A CONNECT tunnel through the proxy, then TLS to the server
function tunnel(url, proxy) {
  return new Promise((resolve, reject) => {
    const port = url.port || 443;
    const client = proxy.protocol === 'https:' ? https : http;
    const request = client.request({
      host: proxy.hostname,
      port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT',
      path: `${url.hostname}:${port}`,
      headers: {Host: `${url.hostname}:${port}`, ...proxyAuthorization(proxy)},
      timeout: TIMEOUT_MS,
    });
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy ${proxy.host} answered ${response.statusCode} to CONNECT ${url.hostname}:${port}`));
        return;
      }
      const secure = tls.connect({socket, servername: url.hostname});
      // Closing the TLS socket leaves the one to the proxy open
      secure.on('close', () => socket.destroy());
      resolve(secure);
    });
    request.on('timeout', () => request.destroy(new Error(`proxy ${proxy.host} timed out`)));
    request.on('error', reject);
    request.end();
  });
}

// GET url into dest, following redirects. Resolves with the response's status code.
async function get(url, dest, redirects = 5) {
  const proxy = proxyFor(url);
  // One request per connection: tunnels and keep-alive sockets would otherwise keep the build's process alive
  const options = {method: 'GET', headers: {'User-Agent': 'qaboard-docs-build', Accept: '*/*', Connection: 'close'}, timeout: TIMEOUT_MS, agent: false};
  let request;
  if (proxy && url.protocol === 'https:') {
    const socket = await tunnel(url, proxy);
    request = https.request(url, {...options, agent: undefined, createConnection: () => socket});
  } else if (proxy) {
    request = http.request({
      ...options, host: proxy.hostname, port: proxy.port || 80, path: url.href,
      headers: {...options.headers, Host: url.host, ...proxyAuthorization(proxy)},
    });
  } else {
    request = (url.protocol === 'https:' ? https : http).request(url, options);
  }
  return new Promise((resolve, reject) => {
    request.on('timeout', () => request.destroy(new Error(`timed out after ${TIMEOUT_MS / 1000}s`)));
    request.on('error', reject);
    request.on('response', response => {
      const {statusCode, headers} = response;
      if (statusCode >= 300 && statusCode < 400 && headers.location) {
        response.resume();
        if (redirects === 0)
          return reject(new Error('too many redirects'));
        return resolve(get(new URL(headers.location, url), dest, redirects - 1));
      }
      if (statusCode !== 200) {
        request.destroy();
        return resolve(statusCode);
      }
      // Proxies that inspect HTTPS answer 200 with their own "blocked" page: don't retry it
      if (/^text\/html\b/i.test(headers['content-type'] ?? '') && !/\.html?$/i.test(url.pathname)) {
        request.destroy();
        return reject(Object.assign(new Error(`${url.href}: got an HTML page instead of the file, probably a proxy blocking it`), {permanent: true}));
      }
      const out = fs.createWriteStream(dest);
      response.pipe(out);
      response.on('error', reject);
      out.on('error', reject);
      out.on('finish', () => {
        request.destroy();
        resolve(statusCode);
      });
    });
    request.end();
  });
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', d => hash.update(d)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

// The file matches its key: size from the manifest, and SHA-256 prefix from its name
async function verify(file, {key, bytes}) {
  const size = fs.statSync(file).size;
  if (size !== bytes)
    return `has ${size} bytes instead of ${bytes}`;
  const expected = path.basename(key).split('.')[0];
  const actual = (await sha256(file)).slice(0, expected.length);
  return actual === expected ? null : `has the SHA-256 ${actual}..., its name says ${expected}...`;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Connection errors can have no message: an AggregateError (one error per address tried) or a bare code
function describe(error, href) {
  const inner = error instanceof AggregateError ? error.errors : [];
  const detail = error.message
    || [error.code, ...inner.map(e => e.code || e.message)].filter(Boolean).join(', ')
    || String(error);
  return detail.includes(href) ? detail : `${href}: ${detail}`;
}

async function fetchOne(file, baseUrl, destDir) {
  const dest = path.join(destDir, file.key);
  const url = new URL(`${baseUrl}/${file.key}`);
  fs.mkdirSync(path.dirname(dest), {recursive: true});
  const part = `${dest}.part`;
  let lastError;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const status = await get(url, part);
      if (status === 404 || status === 403)
        throw Object.assign(new Error(`${url.href}: HTTP ${status}`), {permanent: true});
      if (status !== 200)
        throw new Error(`${url.href}: HTTP ${status}`);
      const problem = await verify(part, file);
      if (problem)
        throw new Error(`${url.href} ${problem}`);
      fs.renameSync(part, dest);
      return;
    } catch (error) {
      lastError = error;
      fs.rmSync(part, {force: true});
      if (error.permanent)
        break;
      if (attempt < ATTEMPTS)
        await sleep(1000 * 2 ** (attempt - 1));
    }
  }
  throw new Error(describe(lastError, url.href));
}

function prune(dir, keep) {
  if (!fs.existsSync(dir))
    return 0;
  let removed = 0;
  for (const dirent of fs.readdirSync(dir, {withFileTypes: true})) {
    const file = path.join(dir, dirent.name);
    if (dirent.isDirectory()) {
      removed += prune(file, keep);
      if (fs.readdirSync(file).length === 0)
        fs.rmdirSync(file);
    } else if (!keep.has(file)) {
      fs.rmSync(file);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Makes destDir/<key> hold exactly `files` ([{key, bytes}]), downloading the missing ones from baseUrl.
 * Returns {downloaded, cached, removed, bytes, failed}. Files that can't be downloaded fail the sync,
 * unless allowFailures: then their keys are in `failed`.
 */
async function syncMedia(files, {baseUrl, destDir, log = () => {}, allowFailures = false}) {
  const keep = new Set(files.map(f => path.join(destDir, f.key)));
  const removed = prune(path.join(destDir, 'shots'), keep);
  const missing = [];
  for (const file of files) {
    const dest = path.join(destDir, file.key);
    if (fs.existsSync(dest) && !(await verify(dest, file)))
      continue;
    fs.rmSync(dest, {force: true});
    missing.push(file);
  }
  const bytes = missing.reduce((sum, f) => sum + f.bytes, 0);
  if (missing.length)
    log(`downloading ${missing.length} files (${(bytes / 1e6).toFixed(1)} MB), ${files.length - missing.length} cached`);
  const failures = [];
  const queue = [...missing];
  await Promise.all(Array.from({length: Math.min(PARALLEL, queue.length)}, async () => {
    while (queue.length) {
      const file = queue.shift();
      try {
        await fetchOne(file, baseUrl, destDir);
      } catch (error) {
        failures.push({key: file.key, message: error.message});
      }
    }
  }));
  if (failures.length && allowFailures) {
    failures.forEach(f => log(`could not download ${f.message}`));
  } else if (failures.length) {
    const list = failures.slice(0, 10).map(f => `  ${f.message}`).join('\n');
    throw new Error(`[qaboard-media] ${failures.length} of ${missing.length} files could not be downloaded:\n${list}\n`
      + 'Build without network access with QABOARD_MEDIA=placeholder, use a mirror with QABOARD_MEDIA_BASE_URL, '
      + 'or render the shots whose files are missing as placeholders with QABOARD_MEDIA_MISSING=placeholder.');
  }
  const failed = failures.map(f => f.key);
  return {downloaded: missing.length - failed.length, cached: files.length - missing.length, removed, bytes, failed};
}

module.exports = {syncMedia, verify, get, bypassesProxy};
