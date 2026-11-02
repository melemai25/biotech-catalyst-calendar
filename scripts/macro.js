#!/usr/bin/env node
/*
 * Macro helpers: transforms, risk composite, date rules, FOMC + CFTC fetchers.
 * No file IO here, build-macro.js does that.
 */

const { PERIODS_PER_YEAR } = require('./macro-spec');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* transforms */

// drop missing obs ('.' from FRED, already null).
// NOTE: after this, 12 rows back != 12 months back. Oct 2025 CPI was never published
// (shutdown), so positional yoy gave a 13 month change. calendar freqs compare by date.
function compact(obs) {
  return obs.filter((o) => o.value !== null && Number.isFinite(o.value));
}

// months per period. daily/weekly not here, they stay positional
const MONTHS_PER_PERIOD = { monthly: 1, quarterly: 3, annual: 12 };

// shift ISO date by n months, clamp the day
function shiftMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + months, 1));
  const span = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, span));
  return t.toISOString().slice(0, 10);
}

// % change needs a positive base
function pctChange(now, then) {
  if (!Number.isFinite(now) || !Number.isFinite(then) || then <= 0) return null;
  return (now / then - 1) * 100;
}

// apply a transform, oldest first. points without enough history are dropped
function transformSeries(obs, transform, freq, scale = 1) {
  const clean = compact(obs).map((o) => ({ date: o.date, value: o.value * scale }));
  const ppy = PERIODS_PER_YEAR[freq] || 12;
  const months = MONTHS_PER_PERIOD[freq] || null;
  const byDate = months ? new Map(clean.map((o) => [o.date, o.value])) : null;
  const out = [];

  // value `steps` periods back, looked up by date on calendar freqs (null if missing)
  const base = (i, steps) => {
    if (byDate) {
      const want = shiftMonths(clean[i].date, -steps * months);
      return byDate.has(want) ? byDate.get(want) : null;
    }
    const j = i - steps;
    return j >= 0 ? clean[j].value : null;
  };

  for (let i = 0; i < clean.length; i++) {
    const v = clean[i].value;
    let t = null;
    let b = null;

    switch (transform) {
      case 'level':
        t = v;
        break;
      case 'mom':
        b = base(i, 1);
        if (b !== null) t = pctChange(v, b);
        break;
      case 'yoy':
        b = base(i, ppy);
        if (b !== null) t = pctChange(v, b);
        break;
      case 'diff':
        b = base(i, 1);
        if (b !== null) t = v - b;
        break;
      case 'pca': {
        // annualized rate (how GDP is quoted)
        b = base(i, 1);
        if (b !== null && b > 0) t = (Math.pow(v / b, ppy) - 1) * 100;
        break;
      }
      default:
        throw new Error(`Unknown transform: ${transform}`);
    }

    if (t !== null && Number.isFinite(t)) out.push({ date: clean[i].date, value: t });
  }

  return out;
}

// spec + observations -> what the page renders. history capped for size
function buildIndicator(spec, obs, meta = null) {
  const series = transformSeries(obs, spec.transform, spec.freq, spec.scale || 1);
  if (!series.length) return null;

  const last = series[series.length - 1];
  const prior = findPrior(series, spec.freq);
  const yearAgo = findYearAgo(series, spec.freq);

  // round first, then get the direction, otherwise you get 'up 0'
  const rawChange = prior ? last.value - prior.value : null;
  const change = rawChange === null ? null : round(rawChange, spec.decimals + 1);

  return {
    id: spec.id,
    group: spec.group,
    label: spec.label,
    sub: spec.sub || null,
    unit: spec.unit,
    decimals: spec.decimals,
    importance: spec.importance,
    goodDirection: spec.goodDirection || null,

    value: round(last.value, spec.decimals),
    asOf: last.date,
    prior: prior ? round(prior.value, spec.decimals) : null,
    change,
    direction: change === null ? null : change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
    yearAgo: yearAgo ? round(yearAgo.value, spec.decimals) : null,

    series: spec.series,
    transform: spec.transform,
    freq: spec.freq,
    // FRED's last_updated (asOf is the period, not the update time)
    lastUpdated: meta ? meta.lastUpdated : null,
    seriesTitle: meta ? meta.title : null,
    sourceUrl: `https://fred.stlouisfed.org/series/${spec.series}`,

    history: series.slice(-60).map((p) => [p.date, round(p.value, spec.decimals + 1)]),
  };
}

// previous period, checked by date so a gap isn't shown as a 1 period change
function findPrior(series, freq) {
  if (series.length < 2) return null;
  const cand = series[series.length - 2];
  const months = MONTHS_PER_PERIOD[freq];
  if (!months) return cand;
  return cand.date === shiftMonths(series[series.length - 1].date, -months) ? cand : null;
}

function findYearAgo(series, freq) {
  if (!series.length) return null;
  const last = series[series.length - 1];
  if (MONTHS_PER_PERIOD[freq]) {
    const want = shiftMonths(last.date, -12);
    return series.find((p) => p.date === want) || null;
  }
  const i = series.length - 1 - (PERIODS_PER_YEAR[freq] || 12);
  return i >= 0 ? series[i] : null;
}

function round(v, d) {
  if (!Number.isFinite(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

/*
 * Risk composite. Open alternative to CNN Fear & Greed (no API).
 * 4 FRED inputs, each shown with its own score. 0-100, 100 = max risk appetite.
 */

// percentile of today's value in its own history (lowest = 0)
function percentile(values, current) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 30) return null;
  const below = v.filter((x) => x < current).length;
  return (below / v.length) * 100;
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

// windows in trading days
const RISK_WINDOW = 504;
const MOMENTUM_WINDOW = 125;

// fullById needs the full series, not `history` (capped at 60 points)
function buildRiskComposite(byId, fullById = {}) {
  const components = [];

  const take = (id) => {
    const ind = byId[id];
    if (!ind) return null;
    const full = fullById[id];
    const values = Array.isArray(full) && full.length
      ? full
      : (ind.history || []).map((h) => h[1]);
    if (values.length < 60) return null;
    return { current: ind.value, values, asOf: ind.asOf };
  };

  // 1. volatility. low VIX vs its 2y range = complacent, so inverted
  const vix = take('vix');
  if (vix) {
    const p = percentile(vix.values.slice(-RISK_WINDOW), vix.current);
    if (p !== null) {
      components.push({
        key: 'volatility',
        label: 'Volatility',
        detail: `VIX at ${vix.current}, ${Math.round(p)}th percentile of its 2-year range`,
        score: Math.round(clamp(100 - p)),
        reading: vix.current,
      });
    }
  }

  // 2. credit. widening HY spreads
  const hy = take('hy-oas');
  if (hy) {
    const p = percentile(hy.values.slice(-RISK_WINDOW), hy.current);
    if (p !== null) {
      components.push({
        key: 'credit',
        label: 'Credit spreads',
        detail: `High-yield OAS at ${hy.current}%, ${Math.round(p)}th percentile of its 2-year range`,
        score: Math.round(clamp(100 - p)),
        reading: hy.current,
      });
    }
  }

  // 3. momentum. price vs 125 day mean, +/-10% = full scale
  const sp = take('sp500');
  if (sp && sp.values.length >= MOMENTUM_WINDOW) {
    const win = sp.values.slice(-MOMENTUM_WINDOW);
    const mean = win.reduce((a, b) => a + b, 0) / win.length;
    const gap = (sp.current / mean - 1) * 100;
    components.push({
      key: 'momentum',
      label: 'Equity momentum',
      detail: `S&P 500 ${gap >= 0 ? 'above' : 'below'} its 125-day average by ${Math.abs(gap).toFixed(1)}%`,
      score: Math.round(clamp(((gap + 10) / 20) * 100)),
      reading: round(gap, 1),
    });
  }

  // 4. curve. steeper = more confidence
  const curve = take('curve-10y2y');
  if (curve) {
    const p = percentile(curve.values.slice(-RISK_WINDOW), curve.current);
    if (p !== null) {
      components.push({
        key: 'curve',
        label: 'Yield curve',
        detail: `10y minus 2y at ${curve.current}%, ${Math.round(p)}th percentile of its 2-year range`,
        score: Math.round(clamp(p)),
        reading: curve.current,
      });
    }
  }

  if (components.length < 3) {
    return { score: null, label: null, components, note: 'Not enough inputs available to compute a composite.' };
  }

  const score = Math.round(components.reduce((a, c) => a + c.score, 0) / components.length);

  return {
    score,
    label: riskLabel(score),
    components,
    method: `Equal-weighted mean of ${components.length} components, each scored 0-100 against its own 2-year range. 100 is maximum risk appetite.`,
    note: null,
  };
}

function riskLabel(score) {
  if (score < 20) return 'Extreme fear';
  if (score < 40) return 'Fear';
  if (score < 60) return 'Neutral';
  if (score < 80) return 'Greed';
  return 'Extreme greed';
}

/* date rules */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const iso = (d) => d.toISOString().slice(0, 10);

// all UTC
function utc(y, m, d) {
  return new Date(Date.UTC(y, m, d));
}

function nthWeekday(year, month, weekday, n) {
  const first = utc(year, month, 1);
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return utc(year, month, 1 + shift + (n - 1) * 7);
}

function lastWeekday(year, month, weekday) {
  const last = utc(year, month + 1, 0);
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return utc(year, month, last.getUTCDate() - shift);
}

// sat holiday -> fri, sun -> mon
function observed(d) {
  const day = d.getUTCDay();
  if (day === 6) return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
  if (day === 0) return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return d;
}

// federal holidays (no releases)
function federalHolidays(year) {
  return new Set([
    observed(utc(year, 0, 1)),            // New Year's Day
    nthWeekday(year, 0, 1, 3),            // MLK Day
    nthWeekday(year, 1, 1, 3),            // Washington's Birthday
    lastWeekday(year, 4, 1),              // Memorial Day
    observed(utc(year, 5, 19)),           // Juneteenth
    observed(utc(year, 6, 4)),            // Independence Day
    nthWeekday(year, 8, 1, 1),            // Labor Day
    nthWeekday(year, 9, 1, 2),            // Columbus Day
    observed(utc(year, 10, 11)),          // Veterans Day
    nthWeekday(year, 10, 4, 4),           // Thanksgiving
    observed(utc(year, 11, 25)),          // Christmas
  ].map(iso));
}

function isBusinessDay(d, holidays) {
  const wd = d.getUTCDay();
  return wd !== 0 && wd !== 6 && !holidays.has(iso(d));
}

// nth business day (ISM)
function nthBusinessDay(year, month, n) {
  const holidays = federalHolidays(year);
  let count = 0;
  for (let day = 1; day <= 31; day++) {
    const d = utc(year, month, day);
    if (d.getUTCMonth() !== month) break;
    if (isBusinessDay(d, holidays)) {
      count++;
      if (count === n) return iso(d);
    }
  }
  return null;
}

// FIXED_EVENTS rule -> dates in a window
function expandFixedEvents(events, fromDate, toDate) {
  const out = [];
  const from = new Date(fromDate + 'T00:00:00Z');
  const to = new Date(toDate + 'T00:00:00Z');

  for (const ev of events) {
    const n = ev.rule === 'first-business-day' ? 1
      : ev.rule === 'third-business-day' ? 3
      : null;
    if (n === null) continue;

    for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
      for (let m = 0; m < 12; m++) {
        const date = nthBusinessDay(y, m, n);
        if (!date || date < fromDate || date > toDate) continue;
        out.push({
          key: `${ev.key}-${date}`,
          releaseKey: ev.key,
          date,
          time: ev.time,
          tz: 'ET',
          short: ev.short,
          name: ev.name,
          group: ev.group,
          importance: ev.importance,
          agency: ev.agency,
          sourceUrl: ev.url,
          // reference period = previous month
          refPeriod: refPeriodForMonthly(y, m),
          valueAvailable: ev.valueAvailable !== false,
          note: ev.note || null,
        });
      }
    }
  }
  return out;
}

function refPeriodForMonthly(year, month) {
  const m = month === 0 ? 11 : month - 1;
  const y = month === 0 ? year - 1 : year;
  return `${MONTHS[m]} ${y}`;
}

/*
 * FOMC calendar. Fed only has a web page, so parse it and reject anything that
 * doesn't validate (warn, no events). data/macro-overrides.json wins.
 */
const FOMC_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

// meetings with projections / dot plot
const SEP_MONTHS = new Set([2, 5, 8, 11]);

// fallback dates if the parse fails. copied from federalreserve.gov on 2026-10-13,
// `date` = 2nd day. runs out after 2 years, build warns
const FOMC_FALLBACK = [
  { startDate: '2026-01-27', date: '2026-01-28' },
  { startDate: '2026-03-17', date: '2026-03-18' },
  { startDate: '2026-04-28', date: '2026-04-29' },
  { startDate: '2026-06-16', date: '2026-06-17' },
  { startDate: '2026-07-28', date: '2026-07-29' },
  { startDate: '2026-09-15', date: '2026-09-16' },
  { startDate: '2026-10-27', date: '2026-10-28' },
  { startDate: '2026-12-08', date: '2026-12-09' },
  { startDate: '2027-01-26', date: '2027-01-27' },
  { startDate: '2027-03-16', date: '2027-03-17' },
  { startDate: '2027-04-27', date: '2027-04-28' },
  { startDate: '2027-06-08', date: '2027-06-09' },
  { startDate: '2027-07-27', date: '2027-07-28' },
  { startDate: '2027-09-14', date: '2027-09-15' },
  { startDate: '2027-10-26', date: '2027-10-27' },
  { startDate: '2027-12-07', date: '2027-12-08' },
].map((m) => ({
  ...m,
  twoDay: true,
  sep: SEP_MONTHS.has(Number(m.date.slice(5, 7)) - 1),
  source: 'fallback',
}));

async function fetchFomcDates() {
  let html;
  try {
    const res = await fetch(FOMC_URL, {
      headers: { 'User-Agent': 'biotech-tracker macro build (contact via repo)' },
    });
    if (!res.ok) return { meetings: [], warning: `FOMC calendar: HTTP ${res.status}` };
    html = await res.text();
  } catch (e) {
    return { meetings: [], warning: `FOMC calendar: ${e.message}` };
  }

  const parsed = parseFomcHtml(html);

  // use the page if it parses, else the fallback table (with a warning)
  const today = new Date().toISOString().slice(0, 10);
  const forward = parsed.meetings.filter((m) => m.date >= today);

  if (forward.length < 4) {
    const fb = FOMC_FALLBACK.filter((m) => m.date >= today);
    if (!fb.length) {
      return {
        meetings: [],
        warning: (parsed.warning ? parsed.warning + ' ' : '') +
          'FOMC: the parse failed AND the built-in fallback dates have run out. ' +
          'Add the dates from federalreserve.gov to data/macro-overrides.json.',
      };
    }
    return {
      meetings: fb,
      warning: (parsed.warning ? parsed.warning + ' ' : '') +
        `FOMC: using ${fb.length} verified fallback dates because the page parse ` +
        'did not validate. These are correct through 2027 and then run out.',
    };
  }

  return parsed;
}

// separate from the fetch so it can be tested offline
function parseFomcHtml(html) {
  // match on text, the page structure is a mess of nested tables
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  const monthAlt = MONTHS.join('|');

  // - only take years from section headings (page has lots of other 4 digit numbers)
  // - only 'Month D-D' ranges count as meetings, single dates are minutes releases
  const yearHeading = /\b(20[2-4]\d)\s+FOMC\s+Meeting/gi;
  const range = new RegExp(
    `\\b(${monthAlt})\\s+(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\b`,
    'gi'
  );

  const sections = [];
  let h;
  while ((h = yearHeading.exec(text)) !== null) {
    sections.push({ year: Number(h[1]), start: h.index });
  }
  if (!sections.length) {
    return { meetings: [], warning: 'FOMC calendar: no year headings found on the page.' };
  }
  for (let i = 0; i < sections.length; i++) {
    sections[i].end = i + 1 < sections.length ? sections[i + 1].start : text.length;
  }

  // skip the historical archive
  const thisYear = new Date().getUTCFullYear();
  const forwardSections = sections.filter((s) => s.year >= thisYear);
  if (!forwardSections.length) {
    return { meetings: [], warning: 'FOMC calendar: no current or future year section on the page.' };
  }

  const byYear = new Map();

  for (const sec of forwardSections) {
    const slice = text.slice(sec.start, sec.end);
    range.lastIndex = 0;
    let m;
    while ((m = range.exec(slice)) !== null) {
      const monthIdx = MONTHS.findIndex((mo) => mo.toLowerCase() === m[1].toLowerCase());
      if (monthIdx < 0) continue;

      const d1 = Number(m[2]);
      const d2 = Number(m[3]);
      if (d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) continue;
      // d2 < d1 means it matched something else
      if (d2 <= d1) continue;
      if (d2 - d1 > 2) continue;   // 2 days, sometimes 3

      if (!byYear.has(sec.year)) byYear.set(sec.year, []);
      byYear.get(sec.year).push({
        year: sec.year,
        monthIdx,
        startDay: d1,
        endDay: d2,
        // decision is on the last day
        date: iso(utc(sec.year, monthIdx, d2)),
        twoDay: true,
      });
    }
  }

  const meetings = [];
  const rejected = [];

  for (const [y, list] of byYear) {
    // 8 meetings a year (+1 unscheduled allowed)
    const uniq = dedupeByDate(list).sort((a, b) => a.date.localeCompare(b.date));
    if (uniq.length < 8 || uniq.length > 9) {
      rejected.push(`${y}: ${uniq.length} parsed, expected 8`);
      continue;
    }

    // two in one month = bad match
    const months = new Set(uniq.map((mt) => mt.monthIdx));
    if (months.size !== uniq.length) {
      rejected.push(`${y}: two meetings parsed in one month`);
      continue;
    }

    for (const mt of uniq) {
      meetings.push({
        date: mt.date,
        startDate: iso(utc(mt.year, mt.monthIdx, mt.startDay)),
        twoDay: mt.twoDay,
        sep: SEP_MONTHS.has(mt.monthIdx),
        source: 'federalreserve.gov',
      });
    }
  }

  meetings.sort((a, b) => a.date.localeCompare(b.date));

  return {
    meetings,
    warning: rejected.length
      ? `FOMC calendar: rejected implausible parse for ${rejected.join(', ')}. ` +
        'Add the dates to data/macro-overrides.json if they are missing from the page.'
      : null,
  };
}

function dedupeByDate(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    if (seen.has(x.date)) continue;
    seen.add(x.date);
    out.push(x);
  }
  return out;
}

/*
 * CFTC Commitments of Traders (legacy futures). Out Fri 15:30 ET for the previous
 * Tuesday, so it's always a few days old. Socrata api, no key, one request.
 */
const COT_URL = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';

// contracts to show. match on contract code first, names drift
const COT_MARKETS = [
  { key: 'spx',    label: 'E-mini S&P 500',   code: '13874A', match: /e-mini.*s&p 500(?!.*(?:value|growth|dividend|esg))/i },
  { key: 'ust10',  label: '10-year Treasury', code: '043602', match: /10[- ]?year u\.?s\.? treasury note/i },
  { key: 'gold',   label: 'Gold',             code: '088691', match: /^gold\b(?!.*(?:mini|micro))/i },
  { key: 'wti',    label: 'WTI crude',        code: '067651', match: /crude oil, light sweet/i },
  { key: 'dollar', label: 'Dollar index',     code: '098662', match: /u\.?s\.?\s*dollar index/i },
];

// column names have changed before, try a few
function pick(row, names) {
  for (const n of names) {
    if (row[n] !== undefined && row[n] !== null && row[n] !== '') {
      const v = Number(row[n]);
      if (Number.isFinite(v)) return v;
    }
  }
  return null;
}

async function fetchPositioning() {
  // last 2 reports for the week-on-week change
  const url = `${COT_URL}?$order=report_date_as_yyyy_mm_dd DESC&$limit=4000`;
  let rows;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return { positioning: [], warning: `CFTC positioning: HTTP ${res.status}` };
    rows = await res.json();
  } catch (e) {
    return { positioning: [], warning: `CFTC positioning: ${e.message}` };
  }
  if (!Array.isArray(rows) || !rows.length) {
    return { positioning: [], warning: 'CFTC positioning: empty response.' };
  }

  const dateOf = (r) => String(r.report_date_as_yyyy_mm_dd || '').slice(0, 10);
  const dates = [...new Set(rows.map(dateOf).filter(Boolean))].sort().reverse();
  const [latest, previous] = dates;
  if (!latest) return { positioning: [], warning: 'CFTC positioning: no report dates found.' };

  const netFor = (row) => {
    const long = pick(row, ['noncomm_positions_long_all', 'noncomm_positions_long_all_nocit']);
    const short = pick(row, ['noncomm_positions_short_all', 'noncomm_positions_short_all_nocit']);
    if (long === null || short === null) return null;
    return { long, short, net: long - short };
  };

  const find = (market, date) => {
    const onDate = rows.filter((r) => dateOf(r) === date);
    const byCode = onDate.find(
      (r) => String(r.cftc_contract_market_code || '').trim().toUpperCase() === market.code
    );
    if (byCode) return byCode;
    return onDate.find((r) => market.match.test(String(r.market_and_exchange_names || '')));
  };

  const positioning = [];
  const missed = [];
  for (const market of COT_MARKETS) {
    const row = find(market, latest);
    if (!row) { missed.push(market.key); continue; }
    const now = netFor(row);
    if (!now) { missed.push(market.key + ' (no position fields)'); continue; }

    let netChange = null;
    if (previous) {
      const prevRow = find(market, previous);
      const was = prevRow ? netFor(prevRow) : null;
      if (was) netChange = now.net - was.net;
    }

    positioning.push({
      key: market.key,
      label: market.label,
      contract: String(row.market_and_exchange_names || '').trim(),
      long: now.long,
      short: now.short,
      net: now.net,
      netChange,
      openInterest: pick(row, ['open_interest_all']),
      asOf: latest,
    });
  }

  return {
    positioning,
    asOf: latest,
    warning: missed.length
      ? `CFTC positioning: ${missed.join(', ')} did not match any contract in the ` +
        `${rows.filter((r) => dateOf(r) === latest).length} rows for ${latest}. ` +
        'Check the code in COT_MARKETS against publicreporting.cftc.gov.'
      : null,
  };
}

module.exports = {
  // transforms
  compact,
  pctChange,
  shiftMonths,
  transformSeries,
  findPrior,
  findYearAgo,
  buildIndicator,
  round,
  // composite
  percentile,
  buildRiskComposite,
  riskLabel,
  // dates
  federalHolidays,
  isBusinessDay,
  nthBusinessDay,
  expandFixedEvents,
  refPeriodForMonthly,
  iso,
  utc,
  MONTHS,
  // adapters
  fetchFomcDates,
  parseFomcHtml,
  fetchPositioning,
  SEP_MONTHS,
  sleep,
};
