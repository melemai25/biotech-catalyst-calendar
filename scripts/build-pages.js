#!/usr/bin/env node
/**
 * build-pages.js — generates the indexable static pages.
 *
 * The app at / is one URL and always will be: a watchlist is a private
 * combination nobody searches for. These generated pages are the front doors
 * that people actually arrive on from search, and each one funnels into the app.
 *
 *   public/ticker/<T>/index.html       one per company      "MRNA catalyst calendar"
 *   public/calendar/<YYYY-MM>/index.html  one per month     "biotech catalysts October 2026"
 *   public/sitemap.xml
 *   public/robots.txt
 *
 * Every page is real HTML with the content already in it — crawlers see the
 * events without running any JavaScript.
 *
 *   node scripts/build-pages.js
 *   node scripts/build-pages.js --base https://you.github.io/repo
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(PUBLIC, 'data');

const args = process.argv.slice(2);
const baseIdx = args.indexOf('--base');
let BASE = baseIdx !== -1 ? args[baseIdx + 1] : (process.env.SITE_BASE_URL || '');
BASE = BASE.replace(/\/+$/, '');

const SITE_NAME = 'Biotech Tracker';
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

function log(m){ process.stdout.write(m + '\n'); }

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  .replace(/"/g,'&quot;').replace(/'/g,'&#39;');

function longDate(iso){
  const d = new Date(iso + 'T00:00:00');
  return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
}

/* ------------------------------------------------------------- template */

function page({ title, description, canonical, depth, body, jsonLd, noindex }){
  const up = '../'.repeat(depth);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="color-scheme" content="light" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
${noindex ? '<meta name="robots" content="noindex, follow" />' : ''}
${canonical && BASE ? `<link rel="canonical" href="${esc(BASE + canonical)}" />` : ''}
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:type" content="website" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${up}styles.css?v=11" />
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
<div class="app seo-page">
${body}
</div>
</body>
</html>
`;
}

function eventRows(events, showTicker){
  if(!events.length) return '<p class="seo-empty">Nothing scheduled.</p>';
  return `<table class="seo-table">
<thead><tr><th>Date</th>${showTicker ? '<th>Ticker</th>' : ''}<th>Event</th><th>Type</th><th>Phase</th></tr></thead>
<tbody>
${events.map(e => `<tr>
<td class="seo-date">${esc(longDate(e.date))}${e.estimated ? ' <span class="seo-est">est.</span>' : ''}</td>
${showTicker ? `<td><strong>${esc(e.ticker)}</strong></td>` : ''}
<td>${e.sourceUrl ? `<a href="${esc(e.sourceUrl)}" rel="nofollow noopener" target="_blank">${esc(e.title)}</a>` : esc(e.title)}</td>
<td>${esc(e.type)}</td>
<td>${esc(e.phase || '—')}</td>
</tr>`).join('\n')}
</tbody></table>`;
}

/** schema.org Event markup — can surface dates directly in search results. */
function eventsJsonLd(events, limit = 25){
  return events.slice(0, limit).map(e => ({
    '@context':'https://schema.org',
    '@type':'Event',
    name: e.title,
    startDate: e.date,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    location: { '@type':'VirtualLocation', url: BASE || 'https://example.com' },
    description: e.summary || '',
    organizer: { '@type':'Organization', name: e.ticker },
  }));
}

/* -------------------------------------------------------- ticker pages */

function tickerPage(ticker, data, today){
  const meta = data || {};
  const all = (meta.events || []).slice().sort((a,b)=>a.date.localeCompare(b.date));
  const upcoming = all.filter(e => e.date >= today);
  const past = all.filter(e => e.date < today).reverse().slice(0, 30);
  const m = meta.metrics || {};
  const name = meta.name || ticker;

  const next = upcoming[0];
  const description = next
    ? `${name} (${ticker}) catalyst calendar. Next event: ${next.title} on ${longDate(next.date)}. ${upcoming.length} upcoming trial readouts, FDA decisions and earnings dates.`
    : `${name} (${ticker}) catalyst calendar: clinical trial milestones, FDA decisions and earnings dates from ClinicalTrials.gov and SEC filings.`;

  // Written content, so the page is not a thin wrapper around a table.
  const intro = [];
  intro.push(`<p>${esc(name)} is tracked here for clinical trial milestones, SEC filings and earnings dates.${meta.focus ? ' Focus area: ' + esc(meta.focus) + '.' : ''}</p>`);
  if(next){
    intro.push(`<p>The next scheduled catalyst is <strong>${esc(next.title)}</strong> on ${esc(longDate(next.date))}${next.estimated ? ', a projected date rather than a confirmed one' : ''}. There ${upcoming.length === 1 ? 'is' : 'are'} ${upcoming.length} upcoming event${upcoming.length === 1 ? '' : 's'} on record.</p>`);
  } else {
    intro.push(`<p>No upcoming catalysts are currently on record for ${esc(ticker)}. Past events are listed below.</p>`);
  }
  if(m.runwayMonths != null){
    intro.push(`<p>Cash runway is approximately <strong>${m.runwayMonths} months</strong> based on the most recent reported cash position and quarterly operating burn${m.cashAsOf ? ' as of ' + esc(m.cashAsOf) : ''}.</p>`);
  } else if(m.cashStatus === 'cash-generating'){
    intro.push(`<p>${esc(name)} generates cash from operations, so a burn-based runway figure does not apply.</p>`);
  }
  const ts = meta.trialStats;
  if(ts && ts.completionRatePct != null){
    intro.push(`<p>Across ${ts.concluded} concluded trials, ${ts.completionRatePct}% reached completion rather than being terminated or withdrawn.</p>`);
  }

  const stats = [
    ['Upcoming catalysts', upcoming.length],
    ['Cash runway', m.runwayMonths != null ? m.runwayMonths + ' months' : (m.cashStatus === 'cash-generating' ? 'Cash generating' : null)],
    ['Cash & investments', m.totalCashUsd != null ? ((m.isUsd === false ? (m.reportingCurrency + ' ') : '$') + (m.totalCashUsd/1e6).toFixed(0) + 'M') : null],
    ['Phase 3 programs', (m.phase3Count != null && m.phase3Count > 0) ? m.phase3Count : null],
  ].filter(([,v]) => v !== null && v !== undefined);

  const body = `
<nav class="seo-crumb"><a href="../../">${esc(SITE_NAME)}</a> › ${esc(ticker)}</nav>
<header class="seo-header">
  <h1>${esc(ticker)} catalyst calendar</h1>
  <p class="seo-sub">${esc(name)}</p>
</header>
${stats.length ? `<div class="seo-stats">${stats.map(([k,v]) =>
  `<div class="seo-stat"><div class="seo-stat-k">${esc(k)}</div><div class="seo-stat-v">${esc(v)}</div></div>`).join('')}</div>` : ''}
<div class="seo-intro">${intro.join('\n')}</div>

<section>
  <h2>Upcoming catalysts</h2>
  ${eventRows(upcoming, false)}
</section>

<div class="seo-cta">
  <p><strong>Track ${esc(ticker)} alongside other companies.</strong> Add it to a watchlist and see every catalyst on one calendar.</p>
  <a class="seo-btn" href="../../?tickers=${encodeURIComponent(ticker)}">Open ${esc(ticker)} in the tracker</a>
</div>

${past.length ? `<section>
  <h2>Recent history</h2>
  ${eventRows(past, false)}
</section>` : ''}

<section class="seo-about">
  <h2>About this data</h2>
  <p>Trial milestones come from the ClinicalTrials.gov v2 API, filings from SEC EDGAR, and financial figures from SEC XBRL company facts. Dates marked <em>est.</em> are projected rather than company-confirmed. This is an information tool, not investment advice — verify anything you act on against the linked primary source.</p>
  <p>Last updated ${esc(meta.generatedDate || '')}.</p>
</section>
`;

  return page({
    title: `${ticker} Catalyst Calendar — Trial Readouts & FDA Dates | ${SITE_NAME}`,
    description,
    canonical: `/ticker/${ticker}/`,
    depth: 2,
    body,
    jsonLd: upcoming.length ? eventsJsonLd(upcoming) : null,
  });
}

/* --------------------------------------------------------- month pages */

function monthPage(ym, events, today){
  const [y, mo] = ym.split('-');
  const label = MONTHS[parseInt(mo,10)-1] + ' ' + y;
  const sorted = events.slice().sort((a,b)=>a.date.localeCompare(b.date));
  const tickers = [...new Set(sorted.map(e=>e.ticker))];

  const body = `
<nav class="seo-crumb"><a href="../../">${esc(SITE_NAME)}</a> › ${esc(label)}</nav>
<header class="seo-header">
  <h1>Biotech catalysts, ${esc(label)}</h1>
  <p class="seo-sub">${sorted.length} tracked event${sorted.length===1?'':'s'} across ${tickers.length} compan${tickers.length===1?'y':'ies'}</p>
</header>
<div class="seo-intro">
  <p>Clinical trial milestones, FDA decision dates, SEC filings and earnings scheduled for ${esc(label)}, compiled from ClinicalTrials.gov and SEC EDGAR.</p>
</div>
<section>${eventRows(sorted, true)}</section>
<div class="seo-cta">
  <p><strong>Build your own view.</strong> Pick the companies you follow and see only their catalysts.</p>
  <a class="seo-btn" href="../../">Open the tracker</a>
</div>
<section class="seo-about">
  <h2>Companies on this page</h2>
  <p>${tickers.map(t=>`<a href="../../ticker/${esc(t)}/">${esc(t)}</a>`).join(' · ')}</p>
</section>
`;
  return page({
    title: `Biotech Catalysts ${esc(label)} — Trial Readouts & FDA Dates | ${SITE_NAME}`,
    description: `Every tracked biotech catalyst in ${label}: ${sorted.length} trial readouts, FDA decisions and earnings dates across ${tickers.length} companies.`,
    canonical: `/calendar/${ym}/`,
    depth: 2,
    body,
    jsonLd: eventsJsonLd(sorted),
  });
}

/* ----------------------------------------------------------------- main */

function main(){
  if(!fs.existsSync(path.join(DATA,'index.json'))){
    log('No public/data/index.json. Run: node scripts/build-data.js');
    process.exit(1);
  }
  const index = JSON.parse(fs.readFileSync(path.join(DATA,'index.json'),'utf8'));
  const today = new Date().toISOString().slice(0,10);
  const tickers = Object.keys(index.tickers || {});
  if(!tickers.length){
    log('index.json has no tickers. Run the data build first.');
    process.exit(1);
  }
  if(!BASE) log('NOTE: no --base URL given, so canonical tags and the sitemap use relative paths.\n      Pass --base https://you.github.io/repo for a correct sitemap.\n');

  const urls = [{ loc:'/', priority:'1.0', changefreq:'daily' }];
  const byMonth = {};
  let written = 0;

  for(const t of tickers){
    const f = path.join(DATA,'ticker',`${t}.json`);
    if(!fs.existsSync(f)) continue;
    const data = JSON.parse(fs.readFileSync(f,'utf8'));

    // A page with almost nothing on it is thin content; skip rather than
    // publish dozens of near-empty pages for Google to judge.
    const evs = data.events || [];
    if(evs.length < 2) continue;

    const dir = path.join(PUBLIC,'ticker',t);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'index.html'), tickerPage(t, data, today));
    urls.push({ loc:`/ticker/${t}/`, priority:'0.8', changefreq:'daily' });
    written++;

    for(const e of evs){
      const ym = e.date.slice(0,7);
      (byMonth[ym] = byMonth[ym] || []).push(e);
    }
  }

  // Only months near the present: a page for 2014 has no search demand.
  const minYm = new Date(Date.now() - 400*86400000).toISOString().slice(0,7);
  const maxYm = new Date(Date.now() + 550*86400000).toISOString().slice(0,7);
  let months = 0;
  for(const [ym, evs] of Object.entries(byMonth)){
    if(ym < minYm || ym > maxYm) continue;
    if(evs.length < 3) continue;
    const dir = path.join(PUBLIC,'calendar',ym);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'index.html'), monthPage(ym, evs, today));
    urls.push({ loc:`/calendar/${ym}/`, priority:'0.6', changefreq:'weekly' });
    months++;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${esc(BASE + u.loc)}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
  fs.writeFileSync(path.join(PUBLIC,'sitemap.xml'), xml);

  fs.writeFileSync(path.join(PUBLIC,'robots.txt'),
`User-agent: *
Allow: /

# The watchlist is one page with a query string for sharing. It is not
# indexed: every ticker combination would be the same content at a new URL.
Disallow: /*?tickers=
${BASE ? `\nSitemap: ${BASE}/sitemap.xml\n` : ''}`);

  log(`Wrote ${written} ticker pages, ${months} month pages`);
  log(`      sitemap.xml with ${urls.length} URLs, robots.txt`);
  log(`\nSkipped ${tickers.length - written} tickers with fewer than 2 events (thin content).`);
  if(!BASE) log('\nRe-run with --base once you know your live URL, or the sitemap will be wrong.');
}

main();
