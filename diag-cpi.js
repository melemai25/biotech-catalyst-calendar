#!/usr/bin/env node
/**
 * Prints what the CPI pipeline actually sees. Run from the repo root:
 *   node diag-cpi.js
 * Paste the whole output.
 */
const path = require('path');
const fred = require(path.join(process.cwd(), 'scripts', 'fred.js'));
const macro = require(path.join(process.cwd(), 'scripts', 'macro.js'));
const { INDICATORS } = require(path.join(process.cwd(), 'scripts', 'macro-spec.js'));

(async () => {
  console.log('--- which code is loaded ---');
  console.log('macro.js has the date fix :', typeof macro.shiftMonths === 'function');
  console.log('macro.js has findPrior    :', typeof macro.findPrior === 'function');
  const spec = INDICATORS.find((i) => i.id === 'cpi-yoy');
  console.log('spec cpi-yoy series       :', spec.series, '| transform', spec.transform, '| freq', spec.freq);

  const key = fred.getApiKey();
  if (!key) { console.log('\nNO FRED KEY FOUND — build-macro cannot have refetched anything.'); return; }

  const obs = await fred.fetchSeries(spec.series, key, { limit: 40 });
  console.log(`\n--- raw ${spec.series}, last 18 observations as FRED returns them ---`);
  for (const o of obs.slice(-18)) {
    console.log('  ', o.date, o.value === null ? '(no value)' : o.value);
  }
  const have = new Set(obs.map((o) => o.date));
  for (const d of ['2025-08-01','2025-09-01','2025-10-01','2025-11-01','2026-08-01','2026-09-01']) {
    const row = obs.find((o) => o.date === d);
    console.log('  check', d, !have.has(d) ? 'ROW ABSENT ENTIRELY' : row.value === null ? 'row present, value null' : `= ${row.value}`);
  }

  const yoy = macro.transformSeries(obs, 'yoy', 'monthly');
  console.log('\n--- computed year-over-year, last 6 ---');
  for (const p of yoy.slice(-6)) console.log('  ', p.date, p.value.toFixed(4));

  const ind = macro.buildIndicator(spec, obs);
  console.log('\n--- what the page would show ---');
  console.log('  value', ind.value, '| asOf', ind.asOf, '| prior', ind.prior, '| change', ind.change);

  // What the file on disk currently says, which is what the browser reads.
  try {
    const onDisk = require(path.join(process.cwd(), 'public', 'data', 'macro.json'));
    const found = [];
    (function walk(o) {
      if (o && typeof o === 'object') {
        if (o.id === 'cpi-yoy') found.push({ series: o.series, value: o.value, asOf: o.asOf, prior: o.prior });
        Object.values(o).forEach(walk);
      }
    })(onDisk);
    console.log('\n--- public/data/macro.json on disk ---');
    console.log('  ', JSON.stringify(found));
    console.log('   generated:', onDisk.generatedDate || onDisk.generated || '(no field)');
  } catch (e) {
    console.log('\ncould not read public/data/macro.json:', e.message);
  }
})().catch((e) => console.error('FAILED:', e.message));
