#!/usr/bin/env node
/*
 * Everything the macro page shows.
 *   INDICATORS    FRED series + transform
 *   RELEASES      how to match a FRED release + its time
 *   FIXED_EVENTS  releases FRED doesn't schedule (ISM)
 * Only `critical` series fail the build, the rest just warn.
 */

/*
 * Indicators
 * transform: level | yoy | mom | diff | pca (annualized, for GDP/PCE)
 * goodDirection: only used for the arrow color. null = no opinion
 */
const INDICATORS = [
  // Inflation
  // CPI yoy uses the NOT seasonally adjusted series (CPIAUCNS / CPILFENS), that's the
  // headline number. mom uses SA (CPIAUCSL / CPILFESL). mixing these up is how we
  // showed 4.0% the day CPI printed 3.7%. PCE is SA for both.
  { id: 'cpi-yoy',       series: 'CPIAUCNS',      transform: 'yoy',   group: 'inflation', label: 'CPI',                   sub: 'year over year',    unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'down', critical: true },
  { id: 'cpi-mom',       series: 'CPIAUCSL',      transform: 'mom',   group: 'inflation', label: 'CPI',                   sub: 'month over month',  unit: '%',  decimals: 2, freq: 'monthly',   importance: 2, goodDirection: 'down' },
  { id: 'core-cpi-yoy',  series: 'CPILFENS',      transform: 'yoy',   group: 'inflation', label: 'Core CPI',              sub: 'year over year',    unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'down', critical: true },
  { id: 'core-cpi-mom',  series: 'CPILFESL',      transform: 'mom',   group: 'inflation', label: 'Core CPI',              sub: 'month over month',  unit: '%',  decimals: 2, freq: 'monthly',   importance: 2, goodDirection: 'down' },
  { id: 'pce-yoy',       series: 'PCEPI',         transform: 'yoy',   group: 'inflation', label: 'PCE',                   sub: 'year over year',    unit: '%',  decimals: 1, freq: 'monthly',   importance: 2, goodDirection: 'down' },
  { id: 'core-pce-yoy',  series: 'PCEPILFE',      transform: 'yoy',   group: 'inflation', label: 'Core PCE',              sub: "the Fed's target",  unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'down', critical: true },
  { id: 'ppi-yoy',       series: 'PPIFIS',        transform: 'yoy',   group: 'inflation', label: 'PPI',                   sub: 'final demand, y/y', unit: '%',  decimals: 1, freq: 'monthly',   importance: 2, goodDirection: 'down' },

  // Jobs
  { id: 'payrolls',      series: 'PAYEMS',        transform: 'diff',  group: 'jobs',      label: 'Nonfarm payrolls',      sub: 'change on month',   unit: 'k',  decimals: 0, freq: 'monthly',   importance: 3, goodDirection: 'up',   critical: true },
  { id: 'unemployment',  series: 'UNRATE',        transform: 'level', group: 'jobs',      label: 'Unemployment rate',     sub: null,                unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'down', critical: true },
  { id: 'earnings-yoy',  series: 'CES0500000003', transform: 'yoy',   group: 'jobs',      label: 'Average hourly earnings', sub: 'year over year',  unit: '%',  decimals: 1, freq: 'monthly',   importance: 2, goodDirection: null },
  { id: 'claims',        series: 'ICSA',          transform: 'level', group: 'jobs',      label: 'Initial jobless claims', sub: 'weekly',           unit: 'k',  decimals: 0, freq: 'weekly',    importance: 2, goodDirection: 'down', scale: 0.001 },
  { id: 'continuing',    series: 'CCSA',          transform: 'level', group: 'jobs',      label: 'Continuing claims',     sub: 'weekly',            unit: 'k',  decimals: 0, freq: 'weekly',    importance: 1, goodDirection: 'down', scale: 0.001 },
  { id: 'openings',      series: 'JTSJOL',        transform: 'level', group: 'jobs',      label: 'Job openings',          sub: 'JOLTS',             unit: 'k',  decimals: 0, freq: 'monthly',   importance: 2, goodDirection: 'up' },
  { id: 'quits',         series: 'JTSQUR',        transform: 'level', group: 'jobs',      label: 'Quits rate',            sub: 'JOLTS',             unit: '%',  decimals: 1, freq: 'monthly',   importance: 1, goodDirection: null },

  // Growth
  { id: 'gdp',           series: 'GDPC1',         transform: 'pca',   group: 'growth',    label: 'Real GDP',              sub: 'annualised q/q',    unit: '%',  decimals: 1, freq: 'quarterly', importance: 3, goodDirection: 'up',   critical: true },
  { id: 'gdpnow',        series: 'GDPNOW',        transform: 'level', group: 'growth',    label: 'GDPNow',                sub: 'Atlanta Fed nowcast', unit: '%', decimals: 1, freq: 'quarterly', importance: 2, goodDirection: 'up', optional: true },
  { id: 'retail',        series: 'RSAFS',         transform: 'mom',   group: 'growth',    label: 'Retail sales',          sub: 'month over month',  unit: '%',  decimals: 1, freq: 'monthly',   importance: 3, goodDirection: 'up' },
  { id: 'retail-ex',     series: 'RSFSXMV',       transform: 'mom',   group: 'growth',    label: 'Retail sales ex-autos', sub: 'month over month',  unit: '%',  decimals: 1, freq: 'monthly',   importance: 1, goodDirection: 'up', optional: true },
  { id: 'indpro',        series: 'INDPRO',        transform: 'mom',   group: 'growth',    label: 'Industrial production', sub: 'month over month',  unit: '%',  decimals: 1, freq: 'monthly',   importance: 1, goodDirection: 'up' },
  { id: 'sentiment',     series: 'UMCSENT',       transform: 'level', group: 'growth',    label: 'Consumer sentiment',    sub: 'U. Michigan',       unit: '',   decimals: 1, freq: 'monthly',   importance: 2, goodDirection: 'up' },
  { id: 'starts',        series: 'HOUST',         transform: 'level', group: 'growth',    label: 'Housing starts',        sub: 'annual rate',       unit: 'k',  decimals: 0, freq: 'monthly',   importance: 1, goodDirection: 'up' },
  { id: 'permits',       series: 'PERMIT',        transform: 'level', group: 'growth',    label: 'Building permits',      sub: 'annual rate',       unit: 'k',  decimals: 0, freq: 'monthly',   importance: 1, goodDirection: 'up' },

  // Cross-asset. no goodDirection
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

// observations per year, for yoy and pca
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

/*
 * Release calendar
 * FRED has dates but no times, so times are hardcoded (agency conventions,
 * e.g. CPI at 08:30 ET). `match` runs against FRED's release name.
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

/*
 * Not on FRED
 * ISM PMI is licensed so there's no free value, but the date follows a rule,
 * so it still goes on the calendar with a link.
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

/*
 * Self-check, runs on require. CPI yoy from the SA series looks fine and is
 * just wrong, so fail loudly.
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
