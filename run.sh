#!/usr/bin/env bash
#
# run.sh — build the catalyst data and serve the site locally.
#
#   ./run.sh              build + serve on port 8000
#   ./run.sh 8080         build + serve on a different port
#   ./run.sh --no-build   skip the data fetch, just serve what's there
#
set -euo pipefail

cd "$(dirname "$0")"

PORT=8000
DO_BUILD=1

for arg in "$@"; do
  case "$arg" in
    --no-build) DO_BUILD=0 ;;
    --help|-h)
      sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    ''|*[!0-9]*) echo "Unrecognised argument: $arg" >&2; exit 1 ;;
    *) PORT="$arg" ;;
  esac
done

say()  { printf '\033[1;36m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
fail() { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

# ---------- prerequisites ----------
command -v node >/dev/null 2>&1 || fail \
"Node.js is not installed. Get it from https://nodejs.org (v18 or newer), then re-run."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node $(node -v) is too old. This needs v18+ for built-in fetch."
fi

# ---------- pick a static server ----------
# Preference order: python3, python, node's http-server via npx.
SERVE_CMD=""
if command -v python3 >/dev/null 2>&1; then
  SERVE_CMD="python3 -m http.server"
elif command -v python >/dev/null 2>&1; then
  SERVE_CMD="python -m http.server"
elif command -v npx >/dev/null 2>&1; then
  SERVE_CMD="npx --yes http-server -p"
else
  fail "No static server available. Install Python 3, or make sure npx is on your PATH."
fi

# ---------- make sure the port is free ----------
# Done with node rather than lsof/netstat, which aren't installed everywhere.
port_free() {
  node -e '
    const net = require("net");
    const s = net.createServer();
    s.once("error", () => process.exit(1));
    s.once("listening", () => s.close(() => process.exit(0)));
    s.listen(Number(process.argv[1]), "127.0.0.1");
  ' "$1" 2>/dev/null
}

if ! port_free "$PORT"; then
  warn "Port $PORT is already in use."
  # Try to stop a previous instance if we have the tools to find it.
  if command -v lsof >/dev/null 2>&1; then
    lsof -ti tcp:"$PORT" | xargs kill 2>/dev/null || true
    sleep 1
  fi
  if ! port_free "$PORT"; then
    NEXT="$PORT"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      NEXT=$((NEXT + 1))
      if port_free "$NEXT"; then break; fi
    done
    if port_free "$NEXT"; then
      warn "Using port $NEXT instead."
      PORT="$NEXT"
    else
      fail "Could not find a free port near $PORT. Pass one explicitly: ./run.sh 9000"
    fi
  fi
fi

# ---------- build ----------
if [ "$DO_BUILD" -eq 1 ]; then
  say "==> Fetching trial data and rebuilding events.json"
  if node scripts/build-data.js; then
    :
  else
    warn "Build script failed outright. Serving whatever data is already on disk."
  fi
  echo
else
  say "==> Skipping build (--no-build)"
fi

if [ ! -f public/data/events.json ]; then
  fail "public/data/events.json does not exist and the build did not create it. Run without --no-build."
fi

# ---------- report what the data looks like ----------
node -e '
  const d = require("./public/data/events.json");
  const today = new Date().toISOString().slice(0,10);
  const past = d.events.filter(e=>e.status==="past").length;
  const up   = d.events.filter(e=>e.status==="upcoming").length;
  console.log(`Data built ${d.generatedDate}  (today is ${today})`);
  console.log(`  ${d.counts.total} events — ${d.counts.curated} curated, ${d.counts.registry} from ClinicalTrials.gov`);
  console.log(`  ${past} already reported, ${up} still upcoming`);
  if ((d.warnings||[]).length) {
    console.log("  NOTE: " + d.warnings.length + " fetch warning(s) — registry milestones may be missing.");
  }
  const next = d.events.filter(e=>e.status==="upcoming")[0];
  if (next) console.log(`  Next catalyst: ${next.date}  ${next.ticker}  ${next.title}`);
' || true
echo

URL="http://localhost:${PORT}"
say "==> Serving at ${URL}"
echo "    Press Ctrl+C to stop."
echo

# ---------- open the browser once the server is actually up ----------
(
  for _ in $(seq 1 40); do
    if command -v curl >/dev/null 2>&1; then
      curl -s -o /dev/null "$URL" && break
    else
      sleep 0.25; break
    fi
    sleep 0.25
  done
  if   command -v open     >/dev/null 2>&1; then open "$URL"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$URL" >/dev/null 2>&1
  elif command -v wslview  >/dev/null 2>&1; then wslview "$URL"
  fi
) >/dev/null 2>&1 &

cd public
if [ "$SERVE_CMD" = "npx --yes http-server -p" ]; then
  exec npx --yes http-server -p "$PORT"
else
  exec $SERVE_CMD "$PORT"
fi
