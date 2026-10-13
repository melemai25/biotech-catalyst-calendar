#!/usr/bin/env node
/**
 * Lists the releases FRED publishes, and checks them against macro-spec.js.
 *
 * FRED's release names are free text and not always what you would guess —
 * the University of Michigan survey, for instance, is not filed under
 * "University of Michigan". When build-macro.js reports fewer matches than
 * there are entries in RELEASES, run this to find the real name.
 *
 *   node scripts/fred-releases.js              check the spec, list misses
 *   node scripts/fred-releases.js home sales   search names for a phrase
 *   node scripts/fred-releases.js --all        dump every release name
 */

const fred = require('./fred');
const { RELEASES } = require('./macro-spec');

const TTY = process.stdout.isTTY;
const c = {
  cyan:  (s) => (TTY ? `\x1b[1;36m${s}\x1b[0m` : s),
  green: (s) => (TTY ? `\x1b[1;32m${s}\x1b[0m` : s),
  amber: (s) => (TTY ? `\x1b[1;33m${s}\x1b[0m` : s),
  red:   (s) => (TTY ? `\x1b[1;31m${s}\x1b[0m` : s),
  dim:   (s) => (TTY ? `\x1b[2m${s}\x1b[0m` : s),
};

const argv = process.argv.slice(2);
const showAll = argv.includes('--all');
const query = argv.filter((a) => !a.startsWith('--')).join(' ').trim();

(async () => {
  const apiKey = fred.getApiKey();
  if (!apiKey) {
    console.error(c.red('No FRED API key. Set FRED_API_KEY or data/config.json -> fredApiKey.'));
    process.exit(1);
  }

  const releases = await fred.fetchReleases(apiKey);
  console.log(c.cyan(`FRED publishes ${releases.length} releases.\n`));

  if (showAll) {
    for (const r of releases.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${String(r.id).padStart(4)}  ${r.name}`);
    }
    return;
  }

  if (query) {
    const words = query.toLowerCase().split(/\s+/);
    const hits = releases.filter((r) => {
      const n = r.name.toLowerCase();
      return words.every((w) => n.includes(w));
    });
    console.log(c.cyan(`Releases matching "${query}":`));
    if (!hits.length) console.log(c.dim('  (none)'));
    for (const r of hits.sort((a, b) => a.name.localeCompare(b.name))) {
      console.log(`  ${String(r.id).padStart(4)}  ${r.name}`);
    }
    return;
  }

  // Default: audit the spec.
  const missing = [];
  console.log(c.cyan('Checking macro-spec.js against FRED:\n'));

  for (const spec of RELEASES) {
    const hits = releases.filter((r) => spec.match.test(r.name));
    if (hits.length === 1) {
      console.log(`  ${c.green('OK  ')} ${spec.key.padEnd(10)} ${c.dim('->')} ${hits[0].name}`);
    } else if (hits.length === 0) {
      console.log(`  ${c.red('MISS')} ${spec.key.padEnd(10)} ${c.dim('pattern:')} ${spec.match}`);
      missing.push(spec);
    } else {
      // More than one match is its own bug: the calendar would carry whichever
      // happened to come first in FRED's ordering.
      console.log(`  ${c.amber('AMBIG')} ${spec.key.padEnd(9)} matches ${hits.length}:`);
      for (const h of hits) console.log(c.dim(`          ${h.id}  ${h.name}`));
    }
  }

  if (!missing.length) {
    console.log(c.green('\nAll release patterns resolve to exactly one FRED release.'));
    return;
  }

  console.log(c.amber(`\n${missing.length} pattern(s) matched nothing. Candidates by keyword:\n`));
  for (const spec of missing) {
    // Search on the spec's own words to surface what FRED actually calls it.
    const words = spec.short.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    const hits = releases.filter((r) => {
      const n = r.name.toLowerCase();
      return words.some((w) => n.includes(w));
    });
    console.log(`  ${c.cyan(spec.key)} (${spec.short})`);
    if (!hits.length) {
      console.log(c.dim('      no release name contains any of: ' + words.join(', ')));
      console.log(c.dim('      FRED may simply not carry this one.'));
    }
    for (const h of hits.slice(0, 8)) console.log(`      ${String(h.id).padStart(4)}  ${h.name}`);
    console.log('');
  }
})().catch((e) => {
  console.error(c.red('Failed: ' + e.message));
  process.exit(1);
});
