# Changelog

## 0.5.0 — unreleased

First release on the v1 ingest protocol, rebuilt from scratch around plugins.

- `createMira()` core (2.04 kB): batched `text/plain` delivery to `/v1/batch/{key}`,
  `sendBeacon` on page hide with a `keepalive` fallback, retries with full-jitter
  backoff and `Retry-After`, Do Not Track / GPC / `__mirafive_ignore` / prerendering /
  local-host guards, a double-boot guard, typed events, and stubs that warn in
  development for members of plugins that are not loaded.
- Plugins, each its own entry: `pageviews` (Navigation API or history patch, hash
  mode), `identity` (consent scopes, anonymous and session ids per PROTOCOL §7,
  `identify`/`reset`), `autocapture`, `siteSearch`, `flags` (bootstrap, values and
  browser documents, segment lookups, previews, overrides, exposures) and `experiments`
  (page-snippet exposures).
- Consentless mode reads no language, time zone or screen and stores nothing.
- `MiraCore` and `Plugin` are exported for framework packages and the hosted tracker.
