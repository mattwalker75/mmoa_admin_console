#!/bin/bash
# START_APP.sh — boots the MMoA admin console.
# Run from the repo root: ./START_APP.sh
#

#
# How to set the admin password
#
#  npm install
#  node scripts/create-local-admin.js matt admin@example.org 'Matt' 'somepassword'
#
#  (or just open the console in a browser — with no admins configured it
#   redirects to the first-run /setup page)
#

# NOTE: This app connects to mmoa_web_app's database. Make sure the web app
# has been initialized first (either by running its SETUP_SQLLITE_DB.sh /
# SETUP_MYSQL_DB.sh script or by booting mmoa_web_app once so its SQLite
# auto-bootstrap runs). The console still boots without it — pages that need
# data show a "Database unavailable" banner.
set -e
cd "$(dirname "$0")"
# Production mode unless the caller set NODE_ENV: Express's default error
# handler renders stack traces into the response in any other mode (app.js
# has its own handler, this is belt and braces).
export NODE_ENV="${NODE_ENV:-production}"
if [ ! -d node_modules ]; then
  npm install
fi
# Dependency check: report known high / critical vulnerabilities in the
# production dependencies. Advisory only — the console still starts; fix
# with `npm audit fix` (or bump the package) and restart. Skipped quietly
# when the registry can't be reached or takes more than 30 s (offline host).
# `npm run audit` runs the full report on demand (see Docs/development.md).
# run_with_timeout SECONDS cmd… — coreutils `timeout` where it exists
# (Linux), `gtimeout` (Homebrew coreutils) or perl's alarm (stock macOS).
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then timeout "$secs" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@"
  elif command -v perl >/dev/null 2>&1; then perl -e 'alarm shift; exec @ARGV' "$secs" "$@"
  else "$@"
  fi
}
# (`|| AUDIT_RC=$?` keeps `set -e` from aborting the start on a non-zero exit.)
AUDIT_RC=0
AUDIT_OUT="$(run_with_timeout 30 npm audit --omit=dev --audit-level=high 2>&1)" || AUDIT_RC=$?
if [ "$AUDIT_RC" -eq 0 ]; then
  : # no high / critical vulnerabilities (or nothing to report)
elif echo "$AUDIT_OUT" | grep -qiE '^# npm audit report|vulnerabilit(y|ies) \(|found [0-9]+ vulnerabilit'; then
  echo ""
  echo "############################################################"
  echo "#  WARNING: npm audit found vulnerable production packages  #"
  echo "############################################################"
  echo "$AUDIT_OUT"
  echo "############################################################"
  echo "#  Starting anyway. Run 'npm audit fix' (or update the      #"
  echo "#  package) and restart. See Docs/development.md.           #"
  echo "############################################################"
  echo ""
else
  echo "[audit] skipped (npm audit unavailable, offline, or timed out)"
fi
# Use `npm start` so the prestart hook rebuilds public/css/tailwind.css
# and refreshes public/js/alpine.min.js before the server boots.
npm start
