#!/usr/bin/env node
/**
 * Declarative spec for the macro page. Everything the page shows is defined
 * here, so adding an indicator is one line rather than a code change.
 *
 * Three tables:
 *   INDICATORS  — the numbers, each one FRED series + a transform
 *   RELEASES    — how to recognise a FRED release and when it drops
 *   FIXED_EVENTS— releases with deterministic dates that FRED does not schedule
 *
 * On `optional`: series ids occasionally get renamed or discontinued upstream.
 * Anything not marked `critical` is allowed to fail with a warning rather than
 * taking the whole build down, which matters because this runs unattended.
 */

/* ------------------------------------------------------------------ *
 * Indicators
 * ------------------------------------------------------------------ *
 *
 * transform:
 *   level — the observation as published
 *   yoy   — percent change from the same period a year earlier
 *   mom   — percent change from the previous period
 *   diff  — absolute change from the previous period
 *   pca   — previous-period change expressed as a compounded annual rate
 *           (this is how GDP and quarterly PCE are conventionally quoted)
 *
 * goodDirection: which way is economically favourable, used only to colour the
 *   arrow. `null` means genuinely ambiguous — inflation falling is good until
 *   it is deflation, so we do not editorialise on the cross-asset block.
 */
const INDICATORS = [
  // ---- Inflation -------------------------------------------------
  //
  // Seasonal adjustment is picked per TRANSFORM, not per series, and getting
  // this backwards is how the dashboard reported 4.0% on a day CPI printed 3.7%.
  //
  //   year-over-year  -> NOT seasonally adjusted (CPIAUCNS, CPILFENS)
  //                      This is what BLS publishes as "the" inflation rate and
  //                      what every headline quotes. Seasonal factors repeat
  //                      annually so they should wash out over twelve months —
  //                      but the factors themselves get revised, and in a given
  //                      year the SA and NSA twelve-month changes can differ by
  //                      a few tenths. Those tenths are the whole story on
  //                      release day.
  //
  //   month-over-month -> seasonally adjusted (CPIAUCSL, CPILFESL)
  //                      An unadjusted monthly change is dominated by the
  //                      season rather than by inflation, so it is not a
  //                      number anyone quotes.
  //
  // PCE stays seasonally adjusted throughout: BEA publishes it that way and
  // the twelve-month change is quoted from the adjusted index.
  { id: 'cpi-yoy',       series: 'CPIAUCNS',      transform: 'yoy',   group: 'inflation', label: 'CPI',                   sub: 'year over year',    unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'down', critical: true },
  { id: 'cpi-mom',       series: 'CPIAUCSL',      transform: 'mom',   group: 'inflation', label: 'CPI',                   sub: 'month over month',  unit: '%',  decimals: 2, freq: 'monthly',   importance: 2, goodDirection: 'down' },
  { id: 'core-cpi-yoy',  series: 'CPILFENS',      transform: 'yoy',   group: 'inflation', label: 'Core CPI',              sub: 'year over year',    unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'down', critical: true },
  { id: 'core-cpi-mom',  series: 'CPILFESL',      transform: 'mom',   group: 'inflation', label: 'Core CPI',              sub: 'month over month',  unit: '%',  decimals: 2, freq: 'monthly',   importance: 2, goodDirection: 'down' },
  { id: 'pce-yoy',       series: 'PCEPI',         transform: 'yoy',   group: 'inflation', label: 'PCE',                   sub: 'year over year',    unit: '%',  decimals: 1, freq: 'monthly',   importance: 2, goodDirection: 'down' },
  { id: 'core-pce-yoy',  series: 'PCEPILFE',      transform: 'yoy',   group: 'inflation', label: 'Core PCE',              sub: "the Fed's target",  unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'down', critical: true },
  { id: 'ppi-yoy',       series: 'PPIFIS',        transform: 'yoy',   group: 'inflation', label: 'PPI',                   sub: 'final demand, y/y', unit: '%',  decimals: 1, freq: 'monthly',   importance: 2, goodDirection: 'down' },

  // ---- Jobs ------------------------------------------------------
  { id: 'payrolls',      series: 'PAYEMS',        transform: 'diff',  group: 'jobs',      label: 'Nonfarm payrolls',      sub: 'change on month',   unit: 'k',  decimals: 0, freq: 'monthly',   importance: 3, goodDirection: 'up',   critical: true },
  { id: 'unemployment',  series: 'UNRATE',        transform: 'level', group: 'jobs',      label: 'Unemployment rate',     sub: null,                unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'down', critical: true },
  { id: 'earnings-yoy',  series: 'CES0500000003', transform: 'yoy',   group: 'jobs',      label: 'Average hourly earnings', sub: 'year over year',  unit: '%',  decimals: 1, freq: 'monthly',   importance: 2, goodDirection: null },
  { id: 'claims',        series: 'ICSA',          transform: 'level', group: 'jobs',      label: 'Initial jobless claims', sub: 'weekly',           unit: 'k',  decimals: 0, freq: 'weekly',    importance: 2, goodDirection: 'down', scale: 0.001 },
  { id: 'continuing',    series: 'CCSA',          transform: 'level', group: 'jobs',      label: 'Continuing claims',     sub: 'weekly',            unit: 'k',  decimals: 0, freq: 'weekly',    importance: 1, goodDirection: 'down', scale: 0.001 },
  { id: 'openings',      series: 'JTSJOL',        transform: 'level', group: 'jobs',      label: 'Job openings',          sub: 'JOLTS',             unit: 'k',  decimals: 0, freq: 'monthly',   importance: 2, goodDirection: 'up' },
  { id: 'quits',         series: 'JTSQUR',        transform: 'level', group: 'jobs',      label: 'Quits rate',            sub: 'JOLTS',             unit: '%',  decimals: 1, freq: 'monthly',   importance: 1, goodDirection: null },

  // ---- Growth ----------------------------------------------------
  { id: 'gdp',           series: 'GDPC1',         transform: 'pca',   group: 'growth',    label: 'Real GDP',              sub: 'annualised q/q',    unit: '%',  decimals: 1, freq: 'quarterly', importance: 3, goodDirection: 'up',   critical: true },
  { id: 'gdpnow',        series: 'GDPNOW',        transform: 'level', group: 'growth',    label: 'GDPNow',                sub: 'Atlanta Fed nowcast', unit: '%', decimals: 1, freq: 'quarterly', importance: 2, goodDirection: 'up', optional: true },
  { id: 'retail',        series: 'RSAFS',         transform: 'mom',   group: 'growth',    label: 'Retail sales',          sub: 'month over month',  unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'up' },
  { id: 'retail-ex',     series: 'RSFSXMV',       transform: 'mom',   group: 'growth',    label: 'Retail sales ex-autos', sub: 'month over month',  unit: '%',  decimals: 1, freq: 'monthly',   importance: 1, goodDirection: 'up', optional: true },
  { id: 'indpro',        series: 'INDPRO',        transform: 'mom',   group: 'growth',    label: 'Industrial production', sub: 'month over month',  unit: '%',  decimals: 1, freq: 'monthly',   importance: 1, goodDirection: 'up' },
  { id: 'sentiment',     series: 'UMCSENT',       transform: 'level', group: 'growth',    label: 'Consumer sentiment',    sub: 'U. Michigan',       unit: '',   decimals: 1, freq: 'monthly',   importance: 2, goodDirection: 'up' },
  { id: 'starts',        series: 'HOUST',         transform: 'level', group: 'growth',    label: 'Housing starts',        sub: 'annual rate',       unit: 'k',  decimals: 0, freq: 'monthly',   importance: 1, goodDirection: 'up' },
  { id: 'permits',       series: 'PERMIT',        transform: 'level', group: 'growth',    label: 'Building permits',      sub: 'annual rate',       unit: 'k',  decimals: 0, freq: 'monthly',   importance: 1, goodDirection: 'up' },

  // ---- Cross-asset ----------------------------------------------
  // These are the "is the market worried" block. No goodDirection: a rising
  // VIX is not bad news in itself, it is information.
  { id: 'vix',           series: 'VIXCLS',        transform: 'level', group: 'cross',     label: 'VIX',                   sub: 'implied volatility', unit: '', decimals: 2, freq: 'daily',     importance: 3, goodDirection: null, critical: true },
  { id: 'sp500',         series: 'SP500',         transform: 'level', group: 'cross',     label: 'S&P 500',               sub: null,                unit: '',   decimals: 0, freq: 'daily',     importance: 2, goodDirection: null },
  { id: 'dgs2',          series: 'DGS2',          transform: 'level', group: 'cross',     label: '2-year Treasury',       sub: null,                unit: '%',  decimals: 2, freq: 'daily',     importance: 2, goodDirection: null },
  { id: 'dgs10',         series: 'DGS10',         transform: 'level', group: 'cross',     label: '10-year Treasury',      sub: null,                unit: '%',  decimals: 2, freq: 'daily',     importance: 3, goodDirection: null, critical: true },
  { id: 'dgs30',         series: 'DGS30',         transform: 'level', group: 'cross',     label: '30-year Treasury',      sub: null,                unit: '%',  decimals: 2, freq: 'daily',     importance: 1, goodDirection: null },
  { id: 'curve-10y2y',   series: 'T10Y2Y',        transform: 'level', group: 'cross',     label: '10y minus 2y',          sub: 'yield curve',       unit: '%',  decimals: 2, freq: 'daily',     importance: 3, goodDirection: null },
  { id: 'curve-10y3m',   series: 'T10Y3M',        transform: 'level', group: 'cross',     label: '10y minus 3m',          sub: 'yield curve',       unit: '%',  decimals: 2, freq: 'daily',     importance: 2, goodDirection: null },
  { id: 'hy-oas',        series: 'BAMLH0A0HYM2',  transform: 'level', group: 'cross',     label: 'High-yield spread',     sub: 'ICE BofA OAS',      unit: '%',  decimals: 2, freq: 'daily',     importance: 3, goodDirection: null, critical: true },
  { id: 'ig-oas',        series: 'BAMLC0A0CM',    transform: 'level', group: 'cross',     label: 'Investment-grade spread', sub: 'ICE BofA OAS',    unit: '%',  decimals: 2, freq: 'daily',     importance: 1, goodDirection: null },
  { id: 'dollar',        series: 'DTWEXBGS',      transform: 'level', group: 'cross',     label: 'Dollar index',          sub: 'broad, trade-weighted', unit: '', decimals: 2, freq: 'daily',   importance: 2, goodDirection: null },
  { id: 'wti',           series: 'DCOILWTICO',    transform: 'level', group: 'cross',     label: 'WTI crude',             sub: null,                unit: '$',  decimals: 2, freq: 'daily',     importance: 2, goodDirection: null },
  { id: 'fedfunds',      series: 'DFF',           transform: 'level', group: 'cross',     label: 'Fed funds',              sub: 'effective rate',   unit: '%',  decimals: 2, freq: 'daily',     importance: 2, goodDirection: null },
];

/** How many observations a year, per frequency. Drives yoy and pca. */
const PERIODS_PER_YEAR = {
  daily: 252,
  weekly: 52,
  monthly: 12,
  quarterly: 4,
  annual: 1,
};

const GROUPS = {
  inflation: { label: 'Inflation',    blurb: 'What the Fed is reacting to.' },
  jobs:      { label: 'Jobs',         blurb: 'The other half of the dual mandate.' },
  growth:    { label: 'Growth',       blurb: 'Output, spending and housing.' },
  cross:     { label: 'Cross-asset',  blurb: 'What markets are pricing right now.' },
};

/* ------------------------------------------------------------------ *
 * Release calendar
 * ------------------------------------------------------------------ *
 *
 * FRED gives the DATE of each release but never the TIME, so release times are
 * hardcoded here. They are stable conventions set by the issuing agency, not
 * guesses — BLS has published CPI at 08:30 ET for decades.
 *
 * `match` runs against FRED's own release name. Anchored where the name is
 * exact, loose where FRED's wording has drifted between vintages.
 */
const RELEASES = [
  { key: 'cpi',       match: /^consumer price index$/i,                      short: 'CPI',                  name: 'Consumer Price Index',           group: 'inflation', time: '08:30', importance: 3, agency: 'BLS',    url: 'https://www.bls.gov/cpi/' },
  { key: 'ppi',       match: /^producer price index/i,                       short: 'PPI',                  name: 'Producer Price Index',           group: 'inflation', time: '08:30', importance: 2, agency: 'BLS',    url: 'https://www.bls.gov/ppi/' },
  { key: 'pce',       match: /^personal income and outlays$/i,               short: 'PCE',                  name: 'Personal Income and Outlays',    group: 'inflation', time: '08:30', importance: 3, agency: 'BEA',    url: 'https://www.bea.gov/data/personal-consumption-expenditures-price-index' },
  { key: 'jobs',      match: /^employment situation$/i,                      short: 'Jobs report',          name: 'Employment Situation',           group: 'jobs',      time: '08:30', importance: 3, agency: 'BLS',    url: 'https://www.bls.gov/news.release/empsit.toc.htm' },
  { key: 'claims',    match: /unemployment insurance weekly claims/i,        short: 'Jobless claims',       name: 'Unemployment Insurance Weekly Claims', group: 'jobs', time: '08:30', importance: 2, agency: 'DOL',   url: 'https://www.dol.gov/ui/data.pdf' },
  { key: 'jolts',     match: /job openings and labor turnover/i,             short: 'JOLTS',                name: 'Job Openings and Labor Turnover', group: 'jobs',     time: '10:00', importance: 2, agency: 'BLS',    url: 'https://www.bls.gov/jlt/' },
  { key: 'gdp',       match: /^gross domestic product$/i,                    short: 'GDP',                  name: 'Gross Domestic Product',         group: 'growth',    time: '08:30', importance: 3, agency: 'BEA',    url: 'https://www.bea.gov/data/gdp/gross-domestic-product' },
  { key: 'retail',    match: /advance monthly (retail )?sales/i,             short: 'Retail sales',         name: 'Advance Monthly Retail Sales',   group: 'growth',    time: '08:30', importance: 3, agency: 'Census', url: 'https://www.census.gov/retail/' },
  { key: 'indpro',    match: /industrial production and capacity utilization/i, short: 'Industrial production', name: 'Industrial Production and Capacity Utilization',   group: 'growth',    time: '09:15', importance: 1, agency: 'Fed',    url: 'https://www.federalreserve.gov/releases/g17/' },
  { key: 'umich',     match: /^surveys of consumers$|university of michigan/i,                      short: 'Consumer sentiment',   name: 'Surveys of Consumers',           group: 'growth',    time: '10:00', importance: 2, agency: 'U. Michigan', url: 'http://www.sca.isr.umich.edu/' },
  { key: 'housing',   match: /^new residential construction$/i,              short: 'Housing starts',       name: 'New Residential Construction',   group: 'growth',    time: '08:30', importance: 1, agency: 'Census', url: 'https://www.census.gov/construction/nrc/' },
  { key: 'newhome',   match: /^new residential sales$/i,                      short: 'New home sales',       name: 'New Residential Sales',          group: 'growth',    time: '10:00', importance: 1, agency: 'Census', url: 'https://www.census.gov/construction/nrs/' },
  { key: 'existing',  match: /existing home sales/i,                         short: 'Existing home sales',  name: 'Existing Home Sales',            group: 'growth',    time: '10:00', importance: 1, agency: 'NAR',    url: 'https://www.nar.realtor/research-and-statistics' },
  { key: 'balance',   match: /^h\.4\.1/i,                                    short: 'Fed balance sheet',    name: 'Factors Affecting Reserve Balances', group: 'fed',   time: '16:30', importance: 1, agency: 'Fed',    url: 'https://www.federalreserve.gov/releases/h41/' },
];

/* ------------------------------------------------------------------ *
 * Releases FRED does not schedule
 * ------------------------------------------------------------------ *
 *
 * ISM's PMI is licensed data. The St. Louis Fed removed it from FRED in 2016
 * at ISM's request, and S&P Global's competing PMI is licensed too, so no free
 * source publishes the VALUE.
 *
 * The DATE, however, is deterministic and published by rule, so the event can
 * still sit on the calendar with a link out to the press release. A scheduled
 * event with no number is more useful than a silent gap, as long as the page
 * says plainly that the number is not included.
 */
const FIXED_EVENTS = [
  {
    key: 'ism-mfg',
    short: 'ISM Manufacturing',
    name: "Purchasing Managers' Index",
    group: 'growth',
    time: '10:00',
    importance: 3,
    agency: 'ISM',
    url: 'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/',
    rule: 'first-business-day',
    valueAvailable: false,
    note: 'Scheduled release time. The reading itself is published by ISM.',
  },
  {
    key: 'ism-services',
    short: 'ISM Services',
    name: "Purchasing Managers' Index",
    group: 'growth',
    time: '10:00',
    importance: 2,
    agency: 'ISM',
    url: 'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/',
    rule: 'third-business-day',
    valueAvailable: false,
    note: 'Scheduled release time. The reading itself is published by ISM.',
  },
];

/* ------------------------------------------------------------------ *
 * Self-check
 * ------------------------------------------------------------------ *
 *
 * Runs on require, because the failure it catches is silent: a CPI year-over-
 * year taken from the seasonally adjusted series produces a number that looks
 * entirely reasonable and is simply not the one the world is quoting. There is
 * no error, no warning, and no way to notice except by reading the news.
 */
for (const i of INDICATORS) {
  const isCpi = /^CPIAUC|^CPILFE/.test(i.series);
  if (!isCpi) continue;
  const nsa = i.series.endsWith('NS');
  if (i.transform === 'yoy' && !nsa) {
    throw new Error(
      `macro-spec: ${i.id} takes a year-over-year change from ${i.series}, which is ` +
      'seasonally adjusted. BLS publishes the headline 12-month change from the ' +
      'unadjusted series — use CPIAUCNS or CPILFENS.'
    );
  }
  if (i.transform === 'mom' && nsa) {
    throw new Error(
      `macro-spec: ${i.id} takes a month-over-month change from ${i.series}, which is ` +
      'unadjusted. An unadjusted monthly change measures the season, not inflation — ' +
      'use CPIAUCSL or CPILFESL.'
    );
  }
}

module.exports = {
  INDICATORS,
  RELEASES,
  FIXED_EVENTS,
  GROUPS,
  PERIODS_PER_YEAR,
};
