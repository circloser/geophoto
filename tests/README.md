# Tests

Dependency-free regression tests. No build step, nothing to install.

```bash
node tests/run.mjs      # or:  npm test
```

## What it checks

1. **Source footguns** — guards against the exact bugs this project has hit:
   a literal `</script>` / `<!--` or a raw U+2028/U+2029 inside the inline app
   script (each silently breaks parsing in the browser but not `node --check`).
2. **Sandbox load** — the app `<script>` is extracted from `index.html` and run
   in a Node `vm` with minimal DOM stubs, proving it evaluates without throwing.
3. **Pure logic** — geometry (`haversine`), day grouping (`dayKey`),
   clustering (`computeClusters`), trip statistics (`computeTripStats`).
4. **i18n** — `setLang()` switching, `t()` key fallback, and **key parity**
   (every Korean string has an English translation and vice-versa).

## Why test this way (and not modularize)

The app ships as a single `index.html` with no bundler — that is a deliberate
product property (zero-build, copy-one-file deploy, trivially auditable). Rather
than split it into modules (a large refactor with real regression risk), the
tests reach into the inline script via `vm` and assert the pure logic directly.

If the codebase later outgrows this, the natural next step is to extract the
pure, DOM-free helpers (geometry, clustering, stats, i18n, EXIF mapping) into a
small `lib.js` that both `index.html` and the tests import — without giving up
the single-file deploy for the rest of the UI.
