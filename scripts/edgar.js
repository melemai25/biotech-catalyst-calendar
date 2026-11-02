#!/usr/bin/env node
/*
 * SEC EDGAR filings: past earnings dates (8-K 2.02), projected next earnings,
 * and 8-K/6-K corporate events.
 *
 * SEC needs a User-Agent with your name + email (else 403 and a ~10 min IP block)
 * and max 10 req/sec. Set it with:
 *   setx EDGAR_USER_AGENT "Your Name you@example.com"
 * or data/config.json { "edgarUserAgent": "..." }
 *
 * 8-Ks come after the fact, so the only forward date is the earnings projection.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS = (cik) => `https://data.sec.gov/submissions/CIK${cik}.json`;

// 8/sec
const REQUEST_GAP_MS = 125;
const MAX_RETRIES = 3;

// 8-K items to keep
const ITEM_MAP = {
  '2.02': { type: 'Earnings',  label: 'Quarterly results' },
  '8.01': { type: 'Other',     label: 'Other event' },
  '7.01': { type: 'Other',     label: 'Reg FD disclosure' },
  '1.01': { type: 'Corporate', label: 'Material agreement' },
  '2.01': { type: 'Corporate', label: 'Acquisition completed' },
  '5.02': { type: 'Corporate', label: 'Leadership change' },
  '3.01': { type: 'Corporate', label: 'Listing / standard notice' },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// foreign filers use 6-K / 20-F with no item codes, so classify 6-Ks by description
const FOREIGN_FORMS = new Set(['6-K', '6-K/A', '20-F', '20-F/A', '40-F', '40-F/A']);

function classifyForeignFiling(form, description) {
  const d = String(description || '').toLowerCase();
  if (/20-F|40-F/i.test(form)) {
    return { type: 'Earnings', label: 'Annual report' };
  }
  if (/\b(result|earning|quarter|interim report|half[- ]year|financial statement|trading update|fy ?20|h[12] 20|q[1-4] ?20)/.test(d)) {
    return { type: 'Earnings', label: 'Results announcement' };
  }
  if (/\b(trial|phase|study|studies|data|topline|readout|approval|regulatory|chmp|ema|fda|marketing authorisation)/.test(d)) {
    return { type: 'Filing', label: 'Clinical or regulatory announcement' };
  }
  if (/\b(acquisi|merger|agreement|collaborat|licen|divest|offering|dividend|buyback|board of|director|officer|appointment)/.test(d)) {
    return { type: 'Corporate', label: 'Corporate announcement' };
  }
  return { type: 'Filing', label: 'Foreign issuer report' };
}

function getUserAgent() {
  if (process.env.EDGAR_USER_AGENT) return process.env.EDGAR_USER_AGENT.trim();
  const cfgPath = path.join(ROOT, 'data', 'config.json');
  if (fs.existsSync(cfgPath)) {
    try {
      const ua = JSON.parse(fs.readFileSync(cfgPath, 'utf8')).edgarUserAgent;
      if (ua && ua.trim() && !ua.includes('you@example.com')) return ua.trim();
    } catch { }
  }
  return null;
}

async function secFetch(url, userAgent) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'application/json',
          'Accept-Encoding': 'gzip, deflate',
        },
      });
    } catch (e) {
      lastErr = e;
      await sleep(600 * (attempt + 1));
      continue;
    }

    if (res.status === 403) {
      throw new Error(
        'HTTP 403 - SEC rejected the request. This almost always means the ' +
        'User-Agent is missing or malformed, or your IP is in a ~10 minute ' +
        'block from exceeding 10 req/sec. Current User-Agent: "' + userAgent + '"'
      );
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(1500 * (attempt + 1));
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    await sleep(REQUEST_GAP_MS);
    return res.json();
  }
  throw lastErr || new Error('request failed');
}

// ticker -> CIK, one request
async function fetchTickerMap(userAgent) {
  const raw = await secFetch(TICKER_MAP_URL, userAgent);
  const map = {};
  for (const row of Object.values(raw)) {
    if (!row || !row.ticker) continue;
    map[String(row.ticker).toUpperCase()] = {
      cik: String(row.cik_str).padStart(10, '0'),
      title: row.title,
    };
  }
  return map;
}

function flattenFilings(sub) {
  const r = (sub.filings || {}).recent || {};
  const n = (r.accessionNumber || []).length;
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({
      accession: r.accessionNumber[i],
      form: r.form[i],
      filingDate: r.filingDate[i],
      reportDate: r.reportDate ? r.reportDate[i] : null,
      items: r.items ? (r.items[i] || '') : '',
      primaryDoc: r.primaryDocument ? r.primaryDocument[i] : null,
      description: r.primaryDocDescription ? r.primaryDocDescription[i] : '',
    });
  }
  return out;
}

function filingUrl(cik, accession, primaryDoc) {
  const clean = String(accession).replace(/-/g, '');
  const cikTrimmed = String(cik).replace(/^0+/, '');
  return `https://www.sec.gov/Archives/edgar/data/${cikTrimmed}/${clean}/${primaryDoc || ''}`;
}

// next earnings = last 2.02 filing + median gap (median handles a late quarter)
function projectNextEarnings(earningsDates, today) {
  if (earningsDates.length < 3) return null;
  const sorted = [...earningsDates].sort();
  const recent = sorted.slice(-6);
  const gaps = [];
  for (let i = 1; i < recent.length; i++) {
    gaps.push((new Date(recent[i]) - new Date(recent[i - 1])) / 86400000);
  }
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];
  // should be ~91 days
  if (median < 60 || median > 130) return null;

  let next = new Date(sorted[sorted.length - 1]);
  const todayMs = new Date(today).getTime();
  let guard = 0;
  while (next.getTime() <= todayMs && guard++ < 8) {
    next = new Date(next.getTime() + median * 86400000);
  }
  if (next.getTime() <= todayMs) return null;
  return next.toISOString().slice(0, 10);
}

function filingsToEvents(filings, ticker, cik, today, lookbackDays = 550) {
  const cutoff = new Date(new Date(today).getTime() - lookbackDays * 86400000)
    .toISOString().slice(0, 10);

  const events = [];
  const earningsDates = [];

  for (const f of filings) {
    if (!f.filingDate) continue;

    const isDomestic = f.form === '8-K' || f.form === '8-K/A';
    const isForeign = FOREIGN_FORMS.has(f.form);
    if (!isDomestic && !isForeign) continue;

    let meta, labels, codes = [];

    if (isDomestic) {
      codes = String(f.items).split(',').map(s => s.trim()).filter(Boolean);
      const known = codes.filter(c => ITEM_MAP[c]);
      if (!known.length) continue;
      if (codes.includes('2.02')) earningsDates.push(f.filingDate);
      const primary = codes.includes('2.02') ? '2.02' : known[0];
      meta = ITEM_MAP[primary];
      labels = known.map(c => ITEM_MAP[c].label);
    } else {
      meta = classifyForeignFiling(f.form, f.description);
      labels = [meta.label];
      if (meta.type === 'Earnings' && /6-K/.test(f.form)) earningsDates.push(f.filingDate);
    }

    if (f.filingDate < cutoff) continue;

    const title = meta.type === 'Earnings'
      ? (isDomestic ? 'Quarterly results filed (8-K)' : `Results filed (${f.form})`)
      : `${f.form} filed: ${labels.join(', ')}`;

    events.push({
      id: `edgar-${ticker}-${f.accession}`,
      ticker,
      date: f.filingDate,
      title,
      type: meta.type === 'Earnings' ? 'Earnings' : meta.type === 'Corporate' ? 'Corporate' : 'Filing',
      phase: null,
      estimated: false,
      summary: `SEC Form ${f.form}${codes.length ? ', items ' + codes.join(', ') : ''}. ${labels.join('; ')}.`
        + (f.description ? ` ${f.description}.` : ''),
      result: meta.type === 'Earnings'
        ? `Results were furnished with this filing. Open the ${f.form} for the earnings release exhibit.`
        : null,
      source: `SEC EDGAR ${f.form} ${f.filingDate}`,
      sourceUrl: filingUrl(cik, f.accession, f.primaryDoc),
      origin: 'edgar',
    });
  }

  const formCounts = {};
  for (const f of filings) formCounts[f.form] = (formCounts[f.form] || 0) + 1;

  const projected = projectNextEarnings(earningsDates, today);
  if (projected) {
    events.push({
      id: `edgar-${ticker}-next-earnings`,
      ticker,
      date: projected,
      title: 'Next quarterly earnings (projected)',
      type: 'Earnings',
      phase: null,
      estimated: true,
      summary: 'Projected from the median gap between this company\u2019s recent '
        + '8-K item 2.02 filings. Not a company-confirmed date \u2014 verify against investor relations.',
      result: null,
      source: 'Projected from SEC EDGAR filing cadence',
      sourceUrl: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=8-K`,
      origin: 'edgar',
    });
  }

  return { events, earningsCount: earningsDates.length, projected, formCounts };
}

/*
 * Filings that mean new money: offerings (424B), private placements (8-K 3.02),
 * new debt (8-K 2.03), 6-K financing announcements.
 * Just a signal, no amounts. A 424B5 can be an ATM that hasn't sold anything.
 */
const OFFERING_FORMS = {
  '424B1': 'Offering prospectus',
  '424B4': 'Offering prospectus',
  '424B2': 'Prospectus supplement',
  '424B5': 'Prospectus supplement',
  '424B3': 'Prospectus (often a resale after a private placement)',
  '424B7': 'Resale prospectus',
};
const FINANCING_ITEMS = {
  '3.02': 'Unregistered sale of shares (private placement)',
  '2.03': 'New debt or financing obligation',
};

function financingSignals(filings, cik, lookbackFrom) {
  const out = [];
  for (const f of filings) {
    if (!f.filingDate || (lookbackFrom && f.filingDate < lookbackFrom)) continue;
    let label = null;
    if (OFFERING_FORMS[f.form]) {
      label = OFFERING_FORMS[f.form];
    } else if (f.form === '8-K' || f.form === '8-K/A') {
      const codes = String(f.items).split(',').map(s => s.trim());
      const hit = codes.find(c => FINANCING_ITEMS[c]);
      if (hit) label = FINANCING_ITEMS[hit];
    } else if (/^6-K/.test(f.form)
        && /\b(offering|placement|financing|subscription|capital raise|registered direct|at-the-market)\b/i.test(f.description || '')) {
      label = 'Financing announcement';
    }
    if (label) {
      out.push({ date: f.filingDate, form: f.form, label,
        url: filingUrl(cik, f.accession, f.primaryDoc) });
    }
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

// financing filed after cashAsOf, newest first
function financingSince(signals, cashAsOf, limit = 5) {
  if (!cashAsOf || !signals) return [];
  return signals.filter(s => s.date > cashAsOf).slice(0, limit);
}

async function fetchCompanyEvents(ticker, cik, today, userAgent) {
  const sub = await secFetch(SUBMISSIONS(cik), userAgent);
  const filings = flattenFilings(sub);
  const result = filingsToEvents(filings, ticker, cik, today);
  const lookbackFrom = new Date(new Date(today).getTime() - 550 * 86400000).toISOString().slice(0, 10);
  return { ...result, totalFilings: filings.length, companyName: sub.name,
    financings: financingSignals(filings, cik, lookbackFrom) };
}

module.exports = {
  getUserAgent,
  classifyForeignFiling,
  FOREIGN_FORMS,
  fetchTickerMap,
  fetchCompanyEvents,
  flattenFilings,
  filingsToEvents,
  projectNextEarnings,
  filingUrl,
  financingSignals,
  financingSince,
  ITEM_MAP,
};
