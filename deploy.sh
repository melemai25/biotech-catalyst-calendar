#!/usr/bin/env bash
#
# deploy.sh — put the site live on the public internet via GitHub Pages.
#
#   ./deploy.sh                    first run: creates the repo, pushes, enables Pages
#   ./deploy.sh --name my-calendar name the repo (default: biotech-catalyst-calendar)
#   ./deploy.sh --private          create a private repo (Pages needs a paid plan for this)
#
# After the first run, ./deploy.sh just pushes your latest changes.
#
set -euo pipefail
cd "$(dirname "$0")"

REPO_NAME="biotech-catalyst-calendar"
VISIBILITY="--public"

while [ $# -gt 0 ]; do
  case "$1" in
    --name) REPO_NAME="$2"; shift 2 ;;
    --private) VISIBILITY="--private"; shift ;;
    --help|-h) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unrecognised argument: $1" >&2; exit 1 ;;
  esac
done

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---------- prerequisites ----------
command -v git >/dev/null 2>&1 || fail "git is not installed. https://git-scm.com/downloads"

if ! command -v gh >/dev/null 2>&1; then
  cat >&2 <<'EOF'

The GitHub CLI (gh) is not installed. It is what makes this one command
instead of ten clicks.

  macOS          brew install gh
  Windows        winget install GitHub.cli
  Linux          https://github.com/cli/cli#installation

Then run:  gh auth login

If you would rather not install it, do this instead:
  1. Create an empty repo at https://github.com/new
  2. git init && git add -A && git commit -m "initial"
  3. git remote add origin https://github.com/YOU/REPO.git
  4. git push -u origin main
  5. Repo Settings -> Pages -> Source: GitHub Actions

EOF
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  warn "You are not signed in to GitHub. Starting login..."
  gh auth login
fi

# ---------- build before shipping ----------
say "==> Building data before deploy"
node scripts/build-data.js || warn "Build had problems; deploying existing data."
echo

# ---------- git init ----------
if [ ! -d .git ]; then
  say "==> Initialising git repository"
  git init -q
  git symbolic-ref HEAD refs/heads/main
fi

git add -A
if git diff --staged --quiet 2>/dev/null; then
  say "==> No changes to commit"
else
  git commit -q -m "Update catalyst calendar ($(date +%Y-%m-%d))"
  ok "    Committed."
fi

# ---------- create or reuse the remote ----------
if git remote get-url origin >/dev/null 2>&1; then
  REMOTE="$(git remote get-url origin)"
  say "==> Using existing remote: $REMOTE"
  git push -u origin main
else
  say "==> Creating GitHub repo '$REPO_NAME'"
  gh repo create "$REPO_NAME" $VISIBILITY --source=. --remote=origin --push
fi

OWNER="$(gh api user --jq .login)"
SLUG="$OWNER/$(basename "$(git remote get-url origin)" .git)"

# ---------- turn on Pages, built by the included Action ----------
say "==> Enabling GitHub Pages (source: GitHub Actions)"
if gh api -X POST "repos/$SLUG/pages" \
     -f 'build_type=workflow' >/dev/null 2>&1; then
  ok "    Pages enabled."
else
  # Already enabled, or needs the build_type switched over.
  if gh api -X PUT "repos/$SLUG/pages" -f 'build_type=workflow' >/dev/null 2>&1; then
    ok "    Pages already enabled; source set to GitHub Actions."
  else
    warn "    Could not enable Pages automatically."
    warn "    Do it by hand: https://github.com/$SLUG/settings/pages"
    warn "    Set Source to 'GitHub Actions'."
  fi
fi

URL="https://${OWNER}.github.io/$(basename "$SLUG")/"

cat <<EOF

$(ok "Deployed.")

  Repo       https://github.com/$SLUG
  Live site  $URL

The first build takes a minute or two. Watch it with:
  gh run watch

After that the site refreshes its trial data on its own, daily at 11:00 UTC,
via .github/workflows/update-data.yml. Force a refresh any time with:
  gh workflow run "Refresh catalyst data"

To push future changes, just run ./deploy.sh again.

EOF
