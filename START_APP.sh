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
# Use `npm start` so the prestart hook rebuilds public/css/tailwind.css
# and refreshes public/js/alpine.min.js before the server boots.
npm start
