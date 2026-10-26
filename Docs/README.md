# Documentation index

Long-form reference for the MMoA Admin Console — the operator tool for
the Mission Men of Anna web app (`mmoa_web_app`).

If you're new here, start with the top-level [project README](../README.md)
and then come back to these pages for depth.

## Pages

- **[architecture.md](architecture.md)** — request lifecycle, middleware
  order, the Web App transport (local / SSH / EC2-SSM), file layout,
  asset pipeline (Tailwind build + Alpine copy), cache-busting.
- **[configuration.md](configuration.md)** — exhaustive `config.json`
  reference. Every key, what it does, default value, and whether
  changing it requires a restart. Also the web-app `config.json` keys the
  Web App Settings page edits.
- **[security.md](security.md)** — auth model (local-file admins,
  break-glass design), session cookies, password rules, brute-force
  throttling, helmet/CSP, input limits, Data Browser / Nonprofits write
  safety, uploads.
- **[database.md](database.md)** — the dual-engine DB abstraction, remote
  SQLite, offline / "dead-DB" mode, the schema this app expects from
  `mmoa_web_app`, and how the Data Browser introspects it.
- **[appearance.md](appearance.md)** — the theme system, dark mode,
  background image / color / opacity, image uploads, the preview
  pipeline.
- **[audit-log.md](audit-log.md)** — the admin audit trail: what gets
  recorded, where the rows live, the Audit log page and the Dashboard's
  Recent activity card.
- **[operator-guide.md](operator-guide.md)** — tab-by-tab user guide for
  the people who use this console day-to-day.
- **[development.md](development.md)** — how to add a page, modify
  styles, debug Alpine, run Tailwind in watch mode, common pitfalls.

## What's in `Docs/` vs the code

These pages document **why** things are the way they are and **how to
think about** the app. For **what the code does**, lean on the source:
each route file, helper and middleware module is commented at the top,
and inline comments flag non-obvious decisions. Treat that as the
authoritative reference; treat these docs as the orientation map.
