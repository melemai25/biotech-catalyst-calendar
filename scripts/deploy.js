#!/usr/bin/env node
/**
 * deploy.js — put the site live on GitHub Pages. Works on Windows, macOS, Linux.
 *
 *   npm run deploy
 *   npm run deploy -- --name my-calendar
 *   npm run deploy -- --private
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TTY = process.stdout.isTTY;
const c = {
  cyan:  (s) => (TTY ? `\x1b[1;36m${s}\x1b[0m` : s),
  green: (s) => (TTY ? `\x1b[1;32m${s}\x1b[0m` : s),
  amber: (s) => (TTY ? `\x1b[1;33m${s}\x1b[0m` : s),
  red:   (s) => (TTY ? `\x1b[1;31m${s}\x1b[0m` : s),
};

let repoName = 'biotech-catalyst-calendar';
let visibility = '--public';

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--name') repoName = argv[++i];
  else if (argv[i] === '--private') visibility = '--private';
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log(`
  npm run deploy                    create repo, push, enable Pages
  npm run deploy -- --name my-cal   choose the repo name
  npm run deploy -- --private       private repo (Pages needs a paid plan)
`);
    process.exit(0);
  }
}

/** Run a command, inheriting stdio. Returns exit status. */
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, shell: process.platform === 'win32', ...opts });
}
/** Run a command and capture stdout. Returns trimmed string, or null on failure. */
function capture(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: process.platform === 'win32' });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}
function has(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  return spawnSync(probe, [cmd], { encoding: 'utf8', shell: process.platform === 'win32' }).status === 0;
}
function die(msg) { console.error(c.red(msg)); process.exit(1); }

// ---------- prerequisites ----------
if (!has('git')) die('git is not installed. Get it from https://git-scm.com/downloads');

if (!has('gh')) {
  console.error(`
The GitHub CLI (gh) is not installed. It is what makes this one command
instead of ten clicks.

  Windows        winget install GitHub.cli
  macOS          brew install gh
  Linux          https://github.com/cli/cli#installation

Then run:  gh auth login

Prefer not to install it? Do this instead:
  1. Create an empty repo at https://github.com/new
  2. git init
     git add -A
     git commit -m "initial"
     git branch -M main
     git remote add origin https://github.com/YOU/REPO.git
     git push -u origin main
  3. Repo Settings -> Pages -> Source: "GitHub Actions"
`);
  process.exit(1);
}

if (spawnSync('gh', ['auth', 'status'], { shell: process.platform === 'win32' }).status !== 0) {
  console.log(c.amber('You are not signed in to GitHub. Starting login...'));
  if (run('gh', ['auth', 'login']).status !== 0) die('Login failed.');
}

// ---------- build ----------
console.log(c.cyan('==> Building data before deploy'));
if (run(process.execPath, [path.join(ROOT, 'scripts', 'build-data.js')]).status !== 0) {
  console.log(c.amber('    Build had problems; deploying existing data.'));
}
console.log('');

// ---------- git ----------
if (capture('git', ['rev-parse', '--is-inside-work-tree']) !== 'true') {
  console.log(c.cyan('==> Initialising git repository'));
  run('git', ['init', '-q']);
  run('git', ['branch', '-M', 'main']);
}

run('git', ['add', '-A']);
const staged = spawnSync('git', ['diff', '--staged', '--quiet'], { cwd: ROOT, shell: process.platform === 'win32' });
if (staged.status === 0) {
  console.log(c.cyan('==> No changes to commit'));
} else {
  const date = new Date().toISOString().slice(0, 10);
  run('git', ['commit', '-q', '-m', `Update catalyst calendar (${date})`]);
  console.log(c.green('    Committed.'));
}

// ---------- remote ----------
const existingRemote = capture('git', ['remote', 'get-url', 'origin']);
if (existingRemote) {
  console.log(c.cyan(`==> Pushing to existing remote: ${existingRemote}`));
  if (run('git', ['push', '-u', 'origin', 'main']).status !== 0) die('Push failed.');
} else {
  console.log(c.cyan(`==> Creating GitHub repo '${repoName}'`));
  if (run('gh', ['repo', 'create', repoName, visibility, '--source=.', '--remote=origin', '--push']).status !== 0) {
    die('Could not create the repo. If the name is taken, try: npm run deploy -- --name something-else');
  }
}

const owner = capture('gh', ['api', 'user', '--jq', '.login']);
const remoteUrl = capture('git', ['remote', 'get-url', 'origin']) || '';
const repo = path.basename(remoteUrl).replace(/\.git$/, '');
const slug = `${owner}/${repo}`;

// ---------- Pages ----------
console.log(c.cyan('==> Enabling GitHub Pages (source: GitHub Actions)'));
const post = spawnSync('gh', ['api', '-X', 'POST', `repos/${slug}/pages`, '-f', 'build_type=workflow'],
  { encoding: 'utf8', shell: process.platform === 'win32' });
if (post.status === 0) {
  console.log(c.green('    Pages enabled.'));
} else {
  const put = spawnSync('gh', ['api', '-X', 'PUT', `repos/${slug}/pages`, '-f', 'build_type=workflow'],
    { encoding: 'utf8', shell: process.platform === 'win32' });
  if (put.status === 0) {
    console.log(c.green('    Pages already enabled; source set to GitHub Actions.'));
  } else {
    console.log(c.amber('    Could not enable Pages automatically.'));
    console.log(c.amber(`    Do it by hand: https://github.com/${slug}/settings/pages`));
    console.log(c.amber("    Set Source to 'GitHub Actions'."));
  }
}

console.log(`
${c.green('Deployed.')}

  Repo       https://github.com/${slug}
  Live site  https://${owner}.github.io/${repo}/

The first build takes a minute or two. Watch it with:
  gh run watch

After that the site refreshes its trial data on its own, daily at 11:00 UTC.
Force a refresh any time with:
  gh workflow run "Refresh catalyst data"

To push future changes, run: npm run deploy
`);
