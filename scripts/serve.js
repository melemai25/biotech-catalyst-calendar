#!/usr/bin/env node
/**
 * serve.js — build the data, then serve the site. Works identically on
 * Windows, macOS and Linux. No bash, no Python, no npm dependencies.
 *
 *   node scripts/serve.js
 *   node scripts/serve.js --port 8080
 *   node scripts/serve.js --no-build
 *   node scripts/serve.js --no-open
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

// ---------- colours (disabled when not a TTY, e.g. piped into a log) ----------
const TTY = process.stdout.isTTY;
const c = {
  cyan:  (s) => (TTY ? `\x1b[1;36m${s}\x1b[0m` : s),
  green: (s) => (TTY ? `\x1b[1;32m${s}\x1b[0m` : s),
  amber: (s) => (TTY ? `\x1b[1;33m${s}\x1b[0m` : s),
  red:   (s) => (TTY ? `\x1b[1;31m${s}\x1b[0m` : s),
  dim:   (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s),
};

// ---------- args ----------
const argv = process.argv.slice(2);
let port = 8000;
// Serving never refetches by default. Data collection is a separate step that
// hits the network for minutes; UI work should not pay that cost.
let doBuild = false;
let doOpen = true;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--no-build') doBuild = false;          // kept so old commands still work
  else if (a === '--build') doBuild = true;
  else if (a === '--no-open') doOpen = false;
  else if (a === '--port' || a === '-p') port = parseInt(argv[++i], 10);
  else if (/^\d+$/.test(a)) port = parseInt(a, 10);
  else if (a === '--help' || a === '-h') {
    console.log(`
Catalyst Calendar — local server

  node scripts/serve.js              serve the site (no network, instant)
  node scripts/serve.js --build      refetch all data first (slow)
  node scripts/serve.js --port 8080  use a specific port
  node scripts/serve.js --no-open    don't open a browser

  Data collection is separate:
    node scripts/build-data.js       fetch trials, filings, financials
    node scripts/build-pages.js      regenerate the static SEO pages
    node scripts/discover.js         rebuild the ticker universe
`);
    process.exit(0);
  } else {
    console.error(c.red(`Unrecognised argument: ${a}`));
    process.exit(1);
  }
}

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(c.red('Port must be a number between 1 and 65535.'));
  process.exit(1);
}

// ---------- node version guard ----------
const major = parseInt(process.versions.node.split('.')[0], 10);
if (major < 18) {
  console.error(c.red(`Node ${process.version} is too old. This needs v18 or newer (for built-in fetch).`));
  console.error('Download a current version from https://nodejs.org');
  process.exit(1);
}

// ---------- build ----------
function build() {
  console.log(c.cyan('==> Fetching trial data and rebuilding events.json'));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-data.js')], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (r.status !== 0) {
    console.log(c.amber('    Build script failed. Serving whatever data is already on disk.'));
  }
  console.log('');
}

// ---------- data summary ----------
function summarise() {
  const p = path.join(PUBLIC_DIR, 'data', 'events.json');
  if (!fs.existsSync(p)) {
    console.error(c.red('public/data/events.json does not exist and the build did not create it.'));
    console.error('Run: node scripts/build-data.js');
    process.exit(1);
  }
  let d;
  try {
    d = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(c.red('events.json is not valid JSON: ' + e.message));
    process.exit(1);
  }
  const today = new Date().toISOString().slice(0, 10);
  const past = d.events.filter((e) => e.status === 'past').length;
  const up = d.events.filter((e) => e.status === 'upcoming').length;
  console.log(`Data built ${d.generatedDate}  (today is ${today})`);
  console.log(`  ${d.counts.total} events — ${d.counts.curated} curated, ${d.counts.registry} from ClinicalTrials.gov`);
  console.log(`  ${past} already reported, ${up} still upcoming`);
  if ((d.warnings || []).length) {
    console.log(c.amber(`  NOTE: ${d.warnings.length} fetch warning(s) — registry milestones may be missing.`));
    for (const w of d.warnings) console.log(c.amber(`        ${w}`));
  }
  const next = d.events.filter((e) => e.status === 'upcoming')[0];
  if (next) console.log(`  Next catalyst: ${next.date}  ${next.ticker}  ${next.title}`);
  console.log('');
}

// ---------- find a free port ----------
function isFree(p) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(p, '127.0.0.1');
  });
}

async function resolvePort(start) {
  for (let p = start; p < start + 20; p++) {
    if (await isFree(p)) {
      if (p !== start) console.log(c.amber(`Port ${start} is in use. Using ${p} instead.`));
      return p;
    }
  }
  console.error(c.red(`No free port found between ${start} and ${start + 19}.`));
  process.exit(1);
}

// ---------- static file server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serve(p) {
  const server = http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400); return res.end('Bad request');
    }
    if (urlPath.endsWith('/')) urlPath += 'index.html';

    // Resolve inside PUBLIC_DIR only — no path traversal.
    const filePath = path.join(PUBLIC_DIR, urlPath);
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('Not found: ' + urlPath);
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
      });
      res.end(buf);
    });

    res.on('finish', () => {
      const code = res.statusCode;
      const mark = code >= 400 ? c.red(String(code)) : c.dim(String(code));
      console.log(`  ${mark} ${urlPath}`);
    });
  });

  server.listen(p, () => {
    const url = `http://localhost:${p}`;
    console.log(c.cyan(`==> Serving at ${url}`));
    console.log('    Press Ctrl+C to stop.');
    console.log(c.dim('    Editing public/ needs only a browser refresh. Data and SEO pages'));
    console.log(c.dim('    are regenerated by their own scripts \u2014 see --help.'));
    console.log('');
    if (doOpen) openBrowser(url);
  });

  server.on('error', (e) => {
    console.error(c.red('Server error: ' + e.message));
    process.exit(1);
  });

  process.on('SIGINT', () => {
    console.log('\n' + c.cyan('Stopped.'));
    process.exit(0);
  });
}

function openBrowser(url) {
  const plat = process.platform;
  try {
    if (plat === 'win32') {
      // 'start' is a cmd builtin; the empty "" is the window title placeholder.
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (plat === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch {
    console.log(c.dim('    (Could not open a browser automatically — open the URL yourself.)'));
  }
}

// ---------- go ----------
(async () => {
  if (doBuild) build();
  else console.log(c.cyan('==> Serving existing data (use --build to refetch)\n'));
  summarise();
  const p = await resolvePort(port);
  serve(p);
})();
