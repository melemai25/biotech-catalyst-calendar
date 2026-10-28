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

const SITE_NAME = 'Biolyst';

/* Set in main() before anything is written, read by siteNav(). */
let HAS_ECON = false;
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

/**
 * The nav every generated page carries.
 *
 * `current` marks the section so the bar says where you are rather than only
 * where you can go, and aria-current carries that to a screen reader. The whole
 * bar is plain anchors in the HTML — these pages exist to be crawled, and a
 * crawler that does not run JavaScript still has to be able to walk the site.
 */
function siteNav(depth, current){
  const up = '../'.repeat(depth);
  // HAS_ECON is decided before any page is written. Linking unconditionally
  // meant that a build without macro.json shipped a 404 in the nav of every
  // page on the site — the kind of thing that is invisible locally and very
  // visible to a crawler.
  const link = (href, label, key) => key === current
    ? `<span class="site-nav-here" aria-current="page">${esc(label)}</span>`
    : `<a href="${up}${href}">${esc(label)}</a>`;
  return `<nav class="site-nav" aria-label="Site">
  <a class="site-nav-brand" href="${up}">${esc(SITE_NAME)}</a>
  <span class="site-nav-links">
    ${link('catalyst-calendar/', 'Catalyst calendar', 'catalyst')}
    ${HAS_ECON ? link('economic-calendar/', 'Economic calendar', 'econ') : ''}
  </span>
  <a class="site-nav-app" href="${up}">Open the tracker &rsaquo;</a>
</nav>`;
}

/**
 * The orientation box under each heading.
 *
 * These generated pages are what people arrive on from search: a list, in date order, no filtering. Someone landing here
 * has no way of knowing there is an app behind it unless the page says so in
 * the first screenful. The wording differs per page type on purpose — the same
 * sentence repeated across 332 pages reads as an advertisement rather than as
 * an explanation, and search engines notice boilerplate too.
 */
function aboutBox(text, href, label){
  return `<aside class="seo-lead">
  <p>${text}</p>
  <a class="seo-btn" href="${esc(href)}">${esc(label)} &rsaquo;</a>
</aside>`;
}

function page({ title, description, canonical, depth, body, jsonLd, noindex, nav }){
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
<link rel="icon" href="${up}favicon.svg" type="image/svg+xml" />
<link rel="icon" href="${up}favicon-32.png" sizes="32x32" type="image/png" />
<link rel="apple-touch-icon" href="${up}apple-touch-icon.png" />
<meta name="theme-color" content="#0E8C97" />
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="${up}styles.css?v=17" />
<style>
  /* Here rather than in styles.css because it belongs to these generated pages
     and nothing else. min-width:0 is the part that matters: a flex or grid
     child defaults to min-content width, which a wide table happily exceeds. */
  .seo-scroll{overflow-x:auto;max-width:100%;min-width:0;-webkit-overflow-scrolling:touch;}
  .seo-scroll > .seo-table{margin:0;}

  .site-nav{
    display:flex;align-items:center;gap:18px;flex-wrap:wrap;
    margin:0 0 18px;padding:0 2px 14px;
    border-bottom:1px solid var(--line-soft,#EAF1F4);
    font-size:13px;
  }
  .site-nav-brand{
    font-size:15px;font-weight:800;letter-spacing:-.02em;
    color:var(--ink,#16343F);text-decoration:none;
  }
  .site-nav-links{display:flex;gap:16px;flex-wrap:wrap;align-items:center;}
  .site-nav a{color:var(--ink-soft,#5A7784);text-decoration:none;}
  .site-nav a:hover{color:var(--teal-dark,#0A6E77);}
  .site-nav-here{color:var(--teal,#0E8C97);font-weight:600;}
  /* Pushed to the far end, so the way back into the app is always in the same
     place rather than wherever the link list happens to end. */
  .site-nav-app{margin-left:auto;font-weight:600;}

  .seo-lead{
    display:flex;align-items:center;gap:16px;flex-wrap:wrap;
    margin:0 0 24px;padding:16px 18px;
    background:var(--teal-wash,#E2F3F5);
    border:1px solid rgba(14,140,151,.18);
    border-radius:var(--r-lg,16px);
  }
  .seo-lead p{
    margin:0;flex:1 1 320px;min-width:0;
    font-size:14px;line-height:1.5;color:var(--ink,#16343F);
  }
  .seo-lead .seo-btn{flex:0 0 auto;}
  @media (max-width:620px){
    .seo-lead{padding:14px;}
    .seo-lead .seo-btn{width:100%;text-align:center;}
  }
  @media (max-width:620px){
    .site-nav{gap:10px;}
    .site-nav-app{margin-left:0;}
  }
</style>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
<div class="app seo-page">
${siteNav(depth, nav)}
${body}
</div>
</body>
</html>
`;
}

function eventRows(events, showTicker){
  if(!events.length) return '<p class="seo-empty">Nothing scheduled.</p>';
  // Wrapped so the table scrolls inside its own box rather than widening the
  // page. A five-column table needs ~580px and a phone has ~350px, so without
  // this every generated page scrolls sideways on mobile.
  return `<div class="seo-scroll"><table class="seo-table">
<thead><tr><th>Date</th>${showTicker ? '<th>Ticker</th>' : ''}<th>Event</th><th>Type</th><th>Phase</th></tr></thead>
<tbody>
${events.map(e => `<tr>
<td class="seo-date">${esc(longDate(e.date))}${e.estimated ? ' <span class="seo-est">est.</span>' : ''}</td>
${showTicker ? `<td><strong>${esc(e.ticker)}</strong></td>` : ''}
<td>${e.sourceUrl ? `<a href="${esc(e.sourceUrl)}" rel="nofollow noopener" target="_blank">${esc(e.title)}</a>` : esc(e.title)}</td>
<td>${esc(e.type)}</td>
<td>${esc(e.phase || '—')}</td>
</tr>`).join('\n')}
</tbody></table></div>`;
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

/* ------------------------------------------------ economic calendar page */

/**
 * "Economic calendar" is a phrase people actually type into a search box, so
 * this gets a real indexable page with the schedule already in the HTML —
 * crawlers see the dates without running the app.
 *
 * Returns null when macro.json has not been built, so the page is simply
 * absent rather than published empty.
 */
function economicCalendarPage(macro, today){
  const upcoming = (macro.releases || [])
    .filter(r => r.status === 'upcoming')
    .slice(0, 60);
  if(upcoming.length < 5) return null;

  const rows = `<div class="seo-scroll"><table class="seo-table">
<thead><tr><th>Date</th><th>Time (ET)</th><th>Release</th><th>Agency</th></tr></thead>
<tbody>
${upcoming.map(r => `<tr>
<td class="seo-date">${esc(longDate(r.date))}</td>
<td>${esc(r.time)}</td>
<td>${r.sourceUrl ? `<a href="${esc(r.sourceUrl)}" rel="nofollow noopener" target="_blank">${esc(r.name)}</a>` : esc(r.name)}${
  r.valueAvailable === false ? ' <span class="seo-est">date only</span>' : ''}</td>
<td>${esc(r.agency)}</td>
</tr>`).join('\n')}
</tbody></table></div>`;

  const key = (macro.indicators || []).filter(i => i.importance === 3 && i.group !== 'cross');
  const latest = key.length ? `<h2>Latest readings</h2>
<div class="seo-scroll"><table class="seo-table">
<thead><tr><th>Indicator</th><th>Latest</th><th>Period</th><th>Prior</th></tr></thead>
<tbody>
${key.map(i => `<tr>
<td><strong>${esc(i.label)}</strong>${i.sub ? ` <span class="seo-est">${esc(i.sub)}</span>` : ''}</td>
<td>${esc(fmtSeoValue(i))}</td>
<td>${esc(i.asOf)}</td>
<td>${i.prior === null ? '—' : esc(fmtSeoValue({ ...i, value: i.prior }))}</td>
</tr>`).join('\n')}
</tbody></table></div>` : '';

  const first = upcoming[0];
  const body = `<div class="masthead">
  <div><h1>Economic <span class="accent">Calendar</span></h1></div>
  <div class="masthead-right"><span class="dot"></span>Updated ${esc(macro.generatedDate || today)}</div>
</div>

${aboutBox(
  'Every scheduled US economic release with its official release time, plus the ' +
  'latest reading and the one before it. Our dashboard adds FOMC meeting dates, ' +
  'the full history behind each series, and a cross-asset strip covering ' +
  'Treasuries, the yield curve, credit spreads, the dollar and VIX. It also runs ' +
  'alongside a biotech catalyst calendar, for anyone weighing company news ' +
  'against the macro backdrop.',
  '../#macro', 'Open our macro dashboard')}

<div class="panel"><div class="panel-body seo-about">
<p>Scheduled US economic releases with their official release times, plus the
latest reading for each of the numbers that move markets. Every release links
to the issuing agency.</p>
<p>Next up: <strong>${esc(first.name)}</strong>, ${esc(longDate(first.date))} at ${esc(first.time)} ET.</p>
</div></div>

<div class="panel">
  <div class="panel-head">Upcoming releases</div>
  <div class="panel-body">${rows}</div>
</div>

${latest ? `<div class="panel"><div class="panel-head">Latest readings</div><div class="panel-body">${latest.replace('<h2>Latest readings</h2>','')}</div></div>` : ''}

<div class="panel seo-cta">
  <p>Track these alongside clinical trial readouts, FDA decisions and earnings
  for the biotech names you follow.</p>
  <a class="seo-btn" href="../#macro">Open the tracker</a>
</div>

<div class="panel"><div class="panel-body seo-about">
<p>Release values and the schedule come from
<a href="https://fred.stlouisfed.org/" rel="nofollow noopener" target="_blank">FRED</a>,
the Federal Reserve Bank of St. Louis. FOMC dates come from the
<a href="https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm" rel="nofollow noopener" target="_blank">Federal Reserve</a>.</p>
<p>This is an information tool, not investment advice.</p>
</div></div>`;

  // schema.org Event markup for the scheduled releases, so dates can surface
  // directly in search results.
  const jsonLd = upcoming.slice(0, 25).map(r => ({
    '@context':'https://schema.org',
    '@type':'Event',
    name: r.name,
    startDate: `${r.date}T${r.time}:00${etOffset(r.date)}`,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode',
    location: { '@type':'VirtualLocation', url: r.sourceUrl || BASE || 'https://example.com' },
    organizer: { '@type':'Organization', name: r.agency },
  }));

  return page({
    title: 'US Economic Calendar — CPI, Jobs, GDP and FOMC Dates',
    description: `Scheduled US economic releases with official times. Next: ${first.name} on ${longDate(first.date)} at ${first.time} ET.`,
    canonical: '/economic-calendar/',
    depth: 1,
    nav: 'econ',
    body,
    jsonLd,
  });
}

/**
 * The UTC offset for US Eastern time on a given date. Release times are quoted
 * in ET, and schema.org startDate needs a real offset — hardcoding -05:00 puts
 * every event an hour out for the roughly eight months of daylight time.
 *
 * DST runs from the second Sunday in March to the first Sunday in November.
 */
function etOffset(isoDate){
  const [y, m, d] = isoDate.split('-').map(Number);
  const nthSunday = (month, n) => {
    const first = new Date(Date.UTC(y, month, 1));
    return 1 + ((7 - first.getUTCDay()) % 7) + (n - 1) * 7;
  };
  const dstStart = { month: 2, day: nthSunday(2, 2) };   // March
  const dstEnd   = { month: 10, day: nthSunday(10, 1) }; // November
  const after  = (mo, dy) => m - 1 > mo || (m - 1 === mo && d >= dy);
  const before = (mo, dy) => m - 1 < mo || (m - 1 === mo && d < dy);
  const inDst = after(dstStart.month, dstStart.day) && before(dstEnd.month, dstEnd.day);
  return inDst ? '-04:00' : '-05:00';
}

function fmtSeoValue(i){
  if(i.value === null || i.value === undefined) return '—';
  const v = Number(i.value).toLocaleString(undefined, {
    minimumFractionDigits: i.decimals, maximumFractionDigits: i.decimals
  });
  return i.unit === '%' ? v + '%' : i.unit === '$' ? '$' + v : i.unit === 'k' ? v + 'k' : v;
}

/* ------------------------------------------------------------- the hub */

/**
 * /catalyst-calendar/ — the page everything else hangs off.
 *
 * Without it the generated pages were unreachable by link. The app at / renders
 * into #root, so a crawler that does not execute JavaScript sees an empty div
 * and no way onward; the ticker and month pages existed only in sitemap.xml,
 * which Google treats as a hint rather than a route. This gives them a real
 * parent, and gives "biotech catalyst calendar" an actual page to rank.
 *
 * It carries a table of near-term events rather than only links, because a page
 * whose entire content is a list of links to other pages is the definition of
 * thin, and gets judged accordingly.
 */
function hubPage({ tickers, months, upcoming, econ, today, generatedDate }){
  const soon = upcoming.slice(0, 40);
  const companies = tickers.slice().sort((a, b) => a[0].localeCompare(b[0]));
  const monthList = months.slice().sort();

  const horizon = soon.length
    ? `${esc(longDate(soon[0].date))} to ${esc(longDate(soon[soon.length - 1].date))}`
    : '';

  const body = `
<header class="seo-header">
  <h1>Biotech Catalyst <span class="accent">Calendar</span></h1>
  <p class="seo-sub">${upcoming.length} upcoming event${upcoming.length === 1 ? '' : 's'} across ${companies.length} compan${companies.length === 1 ? 'y' : 'ies'}</p>
</header>

${aboutBox(
  'Every tracked catalyst in date order, kept current as the registry and SEC ' +
'filings change. Our tracker narrows it to the companies you follow and puts ' +
'their finances beside the dates &mdash; cash, quarterly burn, runway and a ' +
'year&rsquo;s dilution &mdash; so you can see which companies have to raise money ' +
'before their results arrive. It also compares companies side by side, and ' +
'shows how often each one&rsquo;s trials reach completion rather than stopping early.',
'../', 'Open our tracker')}

<div class="seo-intro">
  <p>Clinical trial readouts, FDA decision dates, SEC filings and earnings dates
  for publicly traded biotech and pharmaceutical companies, compiled from the
  ClinicalTrials.gov registry and SEC EDGAR. Every date links back to the filing
  or registry record it came from.</p>
  <p>Dates marked <em>est.</em> are projected primary completion dates from the
  trial registry rather than company-confirmed announcement dates. A sponsor
  typically reports results some weeks after the completion date on record.</p>
</div>

${soon.length ? `<section>
  <h2>Next up</h2>
  <p class="seo-sub">${horizon}</p>
  ${eventRows(soon, true)}
</section>` : ''}

<div class="seo-cta">
  <p><strong>Follow only the companies you care about.</strong> Pick your tickers
  and see their catalysts on one calendar, with cash runway alongside.</p>
  <a class="seo-btn" href="../">Open the tracker</a>
</div>

<section class="seo-about">
  <h2>Companies</h2>
  <p>${companies.map(([t, meta]) =>
    `<a href="../ticker/${esc(t)}/" title="${esc(meta.name || t)}">${esc(t)}</a>`
  ).join(' &middot; ')}</p>
</section>

${monthList.length ? `<section class="seo-about">
  <h2>By month</h2>
  <p>${monthList.map(ym => {
    const [y, mo] = ym.split('-');
    return `<a href="../calendar/${esc(ym)}/">${esc(MONTHS[parseInt(mo,10)-1])} ${esc(y)}</a>`;
  }).join(' &middot; ')}</p>
</section>` : ''}

${econ ? `<section class="seo-about">
  <h2>Macro</h2>
  <p>Trial results do not land in a vacuum. The
  <a href="../economic-calendar/">US economic calendar</a> carries CPI, jobs, GDP
  and FOMC dates alongside, since rates move biotech valuations as much as data does.</p>
</section>` : ''}

<section class="seo-about">
  <h2>About this data</h2>
  <p>Trial milestones come from the ClinicalTrials.gov v2 API, filings from SEC
  EDGAR, and financial figures from SEC XBRL company facts. Nothing here is
  hand-entered. This is an information tool, not investment advice &mdash; verify
  anything you act on against the linked primary source.</p>
  <p>Last updated ${esc(generatedDate || today)}.</p>
</section>
`;

  const description = soon.length
    ? `Upcoming biotech catalysts: ${upcoming.length} trial readouts, FDA decisions and earnings dates across ${companies.length} companies. Next: ${soon[0].ticker} on ${longDate(soon[0].date)}.`
    : `Biotech catalyst calendar covering ${companies.length} companies: clinical trial readouts, FDA decision dates and earnings from ClinicalTrials.gov and SEC EDGAR.`;

  return page({
    title: `Biotech Catalyst Calendar — Trial Readouts & FDA Dates | ${SITE_NAME}`,
    description,
    canonical: '/catalyst-calendar/',
    depth: 1,
    nav: 'catalyst',
    body,
    jsonLd: soon.length ? eventsJsonLd(soon) : null,
  });
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
<nav class="seo-crumb"><a href="../../catalyst-calendar/">Catalyst calendar</a> › ${esc(ticker)}</nav>
<header class="seo-header">
  <h1>${esc(ticker)} catalyst calendar</h1>
  <p class="seo-sub">${esc(name)}</p>
</header>
${aboutBox(
  `Everything on record for ${esc(ticker)}, in date order. The tracker puts ` +
  `${esc(ticker)} on one calendar with the rest of your watchlist, and compares ` +
  `its cash position against the companies you are weighing it against.`,
  `../../?tickers=${encodeURIComponent(ticker)}`, `Open ${esc(ticker)} in the tracker`)}
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
<nav class="seo-crumb"><a href="../../catalyst-calendar/">Catalyst calendar</a> › ${esc(label)}</nav>
<header class="seo-header">
  <h1>Biotech catalysts, ${esc(label)}</h1>
  <p class="seo-sub">${sorted.length} tracked event${sorted.length===1?'':'s'} across ${tickers.length} compan${tickers.length===1?'y':'ies'}</p>
</header>
${aboutBox(
  `Every tracked company&rsquo;s events for ${esc(label)}, which is more than most ` +
  `people want at once. The tracker narrows it to the companies you actually ` +
  `follow and keeps them on one calendar month after month.`,
  '../../', 'Open the tracker')}

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

  // Gathered for the hub while the ticker loop is already reading these files.
  const hubTickers = [];
  const hubUpcoming = [];

  // Economic calendar first, not last: every other page's nav needs to know
  // whether this page exists before it renders. Skipped silently when
  // macro.json has not been built — an empty page is worse than no page.
  let econ = false;
  const macroPath = path.join(DATA,'macro.json');
  if(fs.existsSync(macroPath)){
    try{
      const macro = JSON.parse(fs.readFileSync(macroPath,'utf8'));
      if(macro.available){
        HAS_ECON = true;                       // so siteNav() offers the link
        const html = economicCalendarPage(macro, today);
        if(html){
          const dir = path.join(PUBLIC,'economic-calendar');
          fs.mkdirSync(dir,{recursive:true});
          fs.writeFileSync(path.join(dir,'index.html'), html);
          urls.push({ loc:'/economic-calendar/', priority:'0.9', changefreq:'daily' });
          econ = true;
        } else {
          HAS_ECON = false;                    // page declined to render
        }
      }
    }catch(e){
      log('NOTE: macro.json could not be read (' + e.message + '); economic calendar page skipped.');
    }
  }
  if(!HAS_ECON) log('NOTE: no economic calendar page, so the site nav omits that link.');

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
    hubTickers.push([t, index.tickers[t] || {}]);
    for(const e of evs) if(e.date >= today) hubUpcoming.push(e);

    for(const e of evs){
      const ym = e.date.slice(0,7);
      (byMonth[ym] = byMonth[ym] || []).push(e);
    }
  }

  // Only months near the present: a page for 2014 has no search demand.
  const minYm = new Date(Date.now() - 400*86400000).toISOString().slice(0,7);
  const maxYm = new Date(Date.now() + 550*86400000).toISOString().slice(0,7);
  let months = 0;
  const monthsWritten = [];
  for(const [ym, evs] of Object.entries(byMonth)){
    if(ym < minYm || ym > maxYm) continue;
    if(evs.length < 3) continue;
    const dir = path.join(PUBLIC,'calendar',ym);
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'index.html'), monthPage(ym, evs, today));
    urls.push({ loc:`/calendar/${ym}/`, priority:'0.6', changefreq:'weekly' });
    monthsWritten.push(ym);
    months++;
  }

  // The hub goes last: it links to everything above and needs to know which of
  // those pages actually got written rather than which were merely considered.
  let hub = false;
  if(hubTickers.length){
    hubUpcoming.sort((a,b)=>a.date.localeCompare(b.date));
    const dir = path.join(PUBLIC,'catalyst-calendar');
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,'index.html'), hubPage({
      tickers: hubTickers,
      months: monthsWritten,
      upcoming: hubUpcoming,
      econ,
      today,
      generatedDate: index.generatedDate,
    }));
    // Above the ticker pages it parents, below the app itself.
    urls.push({ loc:'/catalyst-calendar/', priority:'0.9', changefreq:'daily' });
    hub = true;
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

  log(`Wrote ${written} ticker pages, ${months} month pages` + (econ ? ', 1 economic calendar page' : '') + (hub ? ', 1 hub page' : ''));
  log(`      sitemap.xml with ${urls.length} URLs, robots.txt`);
  log(`\nSkipped ${tickers.length - written} tickers with fewer than 2 events (thin content).`);
  if(!BASE) log('\nRe-run with --base once you know your live URL, or the sitemap will be wrong.');
}

main();
