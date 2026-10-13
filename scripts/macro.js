#!/usr/bin/env node
/**
 * Macro helpers: transforms, the risk composite, release-date rules, and the
 * two non-FRED adapters (FOMC calendar, CFTC positioning).
 *
 * Nothing here touches the filesystem or writes output. build-macro.js owns
 * orchestration; this file is pure logic plus two fetchers, so the maths can
 * be tested without a network or an API key.
 */

const { PERIODS_PER_YEAR } = require('./macro-spec');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== *
 * Transforms
 * ================================================================== */

/**
 * Drops missing observations. FRED writes a gap as "." (already nulled by the
 * client), and daily series are full of them for holidays.
 *
 * Compacting first is what makes "12 observations back" mean "12 months back"
 * on a monthly series. Indexing into the raw array instead would silently
 * shift the comparison period whenever a value was missing.
 */
function compact(obs) {
  return obs.filter((o) => o.value !== null && Number.isFinite(o.value));
}

/** Guards every ratio transform: a zero or negative base makes % change meaningless. */
function pctChange(now, then) {
  if (!Number.isFinite(now) || !Number.isFinite(then) || then <= 0) return null;
  return (now / then - 1) * 100;
}

/**
 * Applies one transform across a series, returning [{date, value}] oldest
 * first. Points without enough history to compute are dropped, not zeroed.
 */
function transformSeries(obs, transform, freq, scale = 1) {
  const clean = compact(obs).map((o) => ({ date: o.date, value: o.value * scale }));
  const ppy = PERIODS_PER_YEAR[freq] || 12;
  const out = [];

  for (let i = 0; i < clean.length; i++) {
    const v = clean[i].value;
    let t = null;

    switch (transform) {
      case 'level':
        t = v;
        break;
      case 'mom':
        if (i >= 1) t = pctChange(v, clean[i - 1].value);
        break;
      case 'yoy':
        if (i >= ppy) t = pctChange(v, clean[i - ppy].value);
        break;
      case 'diff':
        if (i >= 1) t = v - clean[i - 1].value;
        break;
      case 'pca': {
        // Compounded annual rate: how fast the economy grew if this period's
        // pace continued for a year. The convention GDP is quoted in.
        if (i >= 1) {
          const prev = clean[i - 1].value;
          if (prev > 0) t = (Math.pow(v / prev, ppy) - 1) * 100;
        }
        break;
      }
      default:
        throw new Error(`Unknown transform: ${transform}`);
    }

    if (t !== null && Number.isFinite(t)) out.push({ date: clean[i].date, value: t });
  }

  return out;
}

/**
 * Turns a spec entry plus raw observations into the shape the page renders.
 * `history` is capped so macro.json stays small — the UI only draws a sparkline.
 */
function buildIndicator(spec, obs, meta = null) {
  const series = transformSeries(obs, spec.transform, spec.freq, spec.scale || 1);
  if (!series.length) return null;

  const last = series[series.length - 1];
  const prior = series.length > 1 ? series[series.length - 2] : null;
  const yearAgo = findYearAgo(series, spec.freq);

  // Round BEFORE deriving the direction. Taking the arrow from the raw change
  // and the number from the rounded one produces "up 0" when a change is too
  // small to survive rounding — an arrow pointing at a figure that denies it.
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
    // FRED's own last_updated is the honest "how fresh is this" signal, as
    // distinct from asOf, which is the period the number describes.
    lastUpdated: meta ? meta.lastUpdated : null,
    seriesTitle: meta ? meta.title : null,
    sourceUrl: `https://fred.stlouisfed.org/series/${spec.series}`,

    history: series.slice(-60).map((p) => [p.date, round(p.value, spec.decimals + 1)]),
  };
}

function findYearAgo(series, freq) {
  const ppy = PERIODS_PER_YEAR[freq] || 12;
  const i = series.length - 1 - ppy;
  return i >= 0 ? series[i] : null;
}

function round(v, d) {
  if (!Number.isFinite(v)) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

/* ================================================================== *
 * Risk composite
 * ================================================================== *
 *
 * A transparent replacement for CNN's Fear & Greed Index, which is a
 * proprietary composite with no public API.
 *
 * Four free inputs, every one of them from FRED, every one of them shown to
 * the reader with its own sub-score. Scored 0-100 where 100 is maximum
 * risk appetite. The point is not to match CNN's number — it is to be a gauge
 * whose workings a reader can check, which a licensed black box never is.
 */

/**
 * Where today's value sits in its own recent history, 0-100.
 * Uses a strict-less-than count, so the lowest value in the window scores 0.
 */
function percentile(values, current) {
  const v = values.filter((x) => Number.isFinite(x));
  if (v.length < 30) return null;
  const below = v.filter((x) => x < current).length;
  return (below / v.length) * 100;
}

function clamp(n, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, n));
}

/** Window lengths in trading days. Two years is long enough to span a regime. */
const RISK_WINDOW = 504;
const MOMENTUM_WINDOW = 125;

/**
 * `fullById` must carry the COMPLETE transformed series per indicator id, not
 * the indicator's `history` field. `history` is capped at 60 points for payload
 * size, and reading percentiles off it would quietly turn every "2-year range"
 * below into a 3-month range, and make the 125-day momentum window impossible
 * to satisfy at all.
 */
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

  // 1. Volatility. A low VIX relative to its own two-year range is complacency,
  //    so the percentile is inverted.
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

  // 2. Credit. Widening high-yield spreads are the earliest honest signal of
  //    stress, which is why this matters more than equity prices.
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

  // 3. Momentum. Price against its own 125-day mean, mapped so +/-10% spans
  //    the full scale. Deliberately crude: a transparent rule beats a fitted one.
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

  // 4. Curve. A steepening curve reads as confidence in future growth; an
  //    inverted one as the opposite. Percentile, not inverted.
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

/* ================================================================== *
 * Date rules
 * ================================================================== */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const iso = (d) => d.toISOString().slice(0, 10);

/** Every date here is built in UTC so the output never shifts with the runner's timezone. */
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

/** Saturday holidays are observed Friday, Sunday holidays the following Monday. */
function observed(d) {
  const day = d.getUTCDay();
  if (day === 6) return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1);
  if (day === 0) return utc(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
  return d;
}

/** The eleven US federal holidays, which are the days agencies do not publish. */
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

/** Nth business day of a month — the rule ISM publishes on. */
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

/**
 * Expands a FIXED_EVENTS rule into dated occurrences across a window. Used for
 * releases whose value is licensed but whose schedule is public and mechanical.
 */
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
          // The reference period is the month just ended.
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

/* ================================================================== *
 * FOMC calendar
 * ================================================================== *
 *
 * The Fed publishes meeting dates years ahead, but only as a web page — there
 * is no feed and no API. So this parses the page, and refuses to publish a
 * result it cannot validate: a bad parse produces a warning and no events,
 * never a plausible-looking wrong date on a calendar people plan around.
 *
 * data/macro-overrides.json can supply or correct dates and always wins.
 */
const FOMC_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

/** Meetings that normally carry a Summary of Economic Projections and a dot plot. */
const SEP_MONTHS = new Set([2, 5, 8, 11]); // March, June, September, December

/**
 * Verified scheduled meeting dates, used only when the page parse fails
 * validation. Transcribed from federalreserve.gov/monetarypolicy/fomccalendars.htm
 * on 2026-10-13; `date` is the second day, which is when the decision lands.
 *
 * This exists because the alternative when the parser breaks is an FOMC-shaped
 * hole in a calendar people plan around. It is NOT a substitute for the parse:
 * it covers two years and then runs out, at which point the build warns.
 */
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

  // The page is the source of truth when it parses cleanly. When it does not,
  // fall back to the verified table rather than leaving a hole — but say so,
  // because the table expires and a silent fallback would hide that.
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

/**
 * Exported separately from the fetch so it can be tested against a saved copy
 * of the page without any network access.
 */
function parseFomcHtml(html) {
  // Collapse to text. The Fed page is heavily nested tables and panels, so
  // matching on structure is brittle; matching on the text is not.
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

  const monthAlt = MONTHS.join('|');

  // Two things go wrong if this is written loosely, and both did:
  //
  //  1. Any bare four-digit number was treated as a year heading, but the page
  //     is full of them — "(released January 2, 2026)" under every past
  //     meeting. So the year is only taken from an actual section heading.
  //
  //  2. Any "Month D" was treated as a meeting, which swept up every
  //     minutes-release date. Scheduled FOMC meetings run two days, so only a
  //     "Month D-D" RANGE counts. That alone removed the contamination that
  //     produced 14-17 "meetings" in a year that has eight.
  const yearHeading = /\b(20[2-4]\d)\s+FOMC\s+Meeting/gi;
  const range = new RegExp(
    `\\b(${monthAlt})\\s+(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\b`,
    'gi'
  );

  // Find each year heading and the span of text that belongs to it.
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

  // The page carries a historical archive going back years, laid out
  // differently from the forward calendar and of no use to a forward-looking
  // page. Parsing it produced warnings about 2023 and 2024 failing to
  // validate, which was true and entirely beside the point.
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
      // A meeting straddling a month end reads as "April 28-May 1", which this
      // pattern cannot represent, so d2 < d1 means something else matched.
      if (d2 <= d1) continue;
      if (d2 - d1 > 2) continue;   // meetings are two days, occasionally three

      if (!byYear.has(sec.year)) byYear.set(sec.year, []);
      byYear.get(sec.year).push({
        year: sec.year,
        monthIdx,
        startDay: d1,
        endDay: d2,
        // The rate decision and press conference land on the FINAL day.
        date: iso(utc(sec.year, monthIdx, d2)),
        twoDay: true,
      });
    }
  }

  const meetings = [];
  const rejected = [];

  for (const [y, list] of byYear) {
    // Validate per year. The FOMC holds exactly eight scheduled meetings a
    // year and has for decades. The window allows one unscheduled addition,
    // which does happen in a crisis, but nothing wider — the first version of
    // this accepted 6 to 12 and duly published 14 "meetings" for 2026.
    const uniq = dedupeByDate(list).sort((a, b) => a.date.localeCompare(b.date));
    if (uniq.length < 8 || uniq.length > 9) {
      rejected.push(`${y}: ${uniq.length} parsed, expected 8`);
      continue;
    }

    // Eight meetings spread across a year sit roughly six weeks apart. Two
    // landing in the same month means something that is not a meeting matched.
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

/* ================================================================== *
 * CFTC positioning
 * ================================================================== *
 *
 * Commitments of Traders, Legacy Futures Only. Published Friday 15:30 ET for
 * the preceding Tuesday, so it is always a few days stale — it shows how
 * speculators were positioned going into the week, not where they are now.
 *
 * Free, keyless Socrata API. No rate limit documented; one request total.
 */
const COT_URL = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';

/**
 * The contracts worth showing.
 *
 * Matched on CFTC contract market code first. The codes are stable identifiers;
 * the names are free text that drifts ("GOLD - COMMODITY EXCHANGE INC." has
 * also appeared as "GOLD - COMMODITY EXCHANGE INC"), which is why the first
 * version matched only three of these five. The name pattern stays as a
 * fallback in case a code is ever reassigned.
 */
const COT_MARKETS = [
  { key: 'spx',    label: 'E-mini S&P 500',   code: '13874A', match: /e-mini.*s&p 500(?!.*(?:value|growth|dividend|esg))/i },
  { key: 'ust10',  label: '10-year Treasury', code: '043602', match: /10[- ]?year u\.?s\.? treasury note/i },
  { key: 'gold',   label: 'Gold',             code: '088691', match: /^gold\b(?!.*(?:mini|micro))/i },
  { key: 'wti',    label: 'WTI crude',        code: '067651', match: /crude oil, light sweet/i },
  { key: 'dollar', label: 'Dollar index',     code: '098662', match: /u\.?s\.?\s*dollar index/i },
];

/** Socrata column names have changed before, so each field tries candidates. */
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
  // Two most recent report dates, so net change week-on-week can be computed.
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

  // Code first, name only as a fallback.
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
  transformSeries,
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
