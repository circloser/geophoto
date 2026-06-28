// GeoPhoto regression tests — dependency-free, no build step.
// Run with:  node tests/run.mjs
//
// Strategy: the app ships as a single index.html. Rather than modularize it
// (which would break the zero-build, single-file deploy), we extract the inline
// <script>, run it inside a Node `vm` sandbox with minimal DOM stubs, and assert
// the PURE logic (geometry, clustering, trip stats, i18n). We also scan the app
// script source for the specific footguns that have bitten this project before
// (a literal closing-script tag / comment-open / raw line separators inside the
// script, and i18n key drift between languages).

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

// ---- extract the main inline app <script> (the lone "<script>" line) ----
const lines = html.split('\n');
let open = -1;
for (let i = 0; i < lines.length; i++) if (lines[i].trim() === '<script>') { open = i; break; }
if (open < 0) { console.error('FAIL: could not find app <script>'); process.exit(1); }
const body = [];
let closeLine = -1;
for (let i = open + 1; i < lines.length; i++) {
  if (/<\/script>/.test(lines[i])) { closeLine = i; break; }
  body.push(lines[i]);
}
const appScript = body.join('\n');

const results = [];
const ok = (name, cond, detail) => results.push({ name, pass: !!cond, detail: cond ? '' : (detail || '') });
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// ---- 1) source-level footgun guards (the bugs we actually hit) ----
ok('app script found', appScript.length > 1000);
ok('no literal </script> inside app script', !/<\/script>/.test(appScript),
   'a literal closing-script tag truncates the inline script in the browser');
ok('no literal <!-- inside app script', !/<!--/.test(appScript),
   'a literal comment-open can flip the HTML tokenizer into double-escaped state');
ok('no raw U+2028 in app script', !new RegExp(String.fromCharCode(0x2028)).test(appScript),
   'a raw line separator inside a regex literal is a SyntaxError');
ok('no raw U+2029 in app script', !new RegExp(String.fromCharCode(0x2029)).test(appScript));

// ---- 2) load the script in a stubbed sandbox ----
const localStore = new Map();
const elStub = () => new Proxy({}, {
  get(_, p) {
    if (p === 'style') return {};
    if (p === 'classList') return { add() {}, remove() {}, toggle() {}, contains() { return true; } };
    if (p === 'getContext') return () => ctxStub;
    if (p === 'toDataURL') return () => 'data:,';
    if (p === 'getBoundingClientRect') return () => ({ width: 0, height: 0, left: 0, top: 0 });
    if (p === 'appendChild' || p === 'removeChild' || p === 'addEventListener' ||
        p === 'removeEventListener' || p === 'setAttribute' || p === 'removeAttribute' ||
        p === 'remove' || p === 'click' || p === 'focus') return () => {};
    if (p === 'querySelector') return () => null;
    if (p === 'querySelectorAll') return () => [];
    if (p === 'clientWidth' || p === 'clientHeight' || p === 'width' || p === 'height') return 0;
    if (p === 'parentElement' || p === 'firstChild') return null;
    return undefined;
  },
  set() { return true; },
});
const ctxStub = new Proxy({}, { get: () => () => {}, set: () => true });
const documentStub = {
  getElementById: () => elStub(),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => elStub(),
  createElementNS: () => elStub(),
  addEventListener: () => {},
  documentElement: { lang: 'ko', style: {} },
  head: { appendChild: () => {} },
  body: { appendChild: () => {}, classList: { add() {}, remove() {} } },
  fullscreenElement: null,
};
const sandbox = {
  console, Math, Date, JSON, Array, Object, String, Number, Boolean, RegExp, Map, Set,
  Promise, Error, parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent,
  setTimeout, clearTimeout, setInterval, clearInterval,
  document: documentStub,
  navigator: { onLine: true, language: 'ko', serviceWorker: undefined },
  performance: { now: () => Date.now() },
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  localStorage: {
    getItem: k => (localStore.has(k) ? localStore.get(k) : null),
    setItem: (k, v) => localStore.set(k, String(v)),
    removeItem: k => localStore.delete(k),
  },
  location: { href: 'http://localhost/', reload: () => {} },
  fetch: async () => ({ ok: false, json: async () => ({}), text: async () => '' }),
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  Blob: globalThis.Blob || class {}, File: globalThis.File || class {},
  Image: class { set src(_) {} },
  createImageBitmap: async () => ({ width: 1, height: 1, close() {} }),
  alert: () => {}, confirm: () => true,
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.window.addEventListener = () => {};

const ctx = createContext(sandbox);
let loaded = true;
try { runInContext(appScript, ctx, { filename: 'app.js' }); }
catch (e) { loaded = false; ok('app script loads in sandbox', false, e.message); }

// ---- 3) drive pure-logic assertions inside the app's own scope ----
if (loaded) {
  ok('app script loads in sandbox', true);
  const driver = `(() => {
    const R = [];
    const ok = (name, cond, detail) => R.push({ name, pass: !!cond, detail: cond ? '' : String(detail||'') });
    const near = (a,b,tol) => Math.abs(a-b) <= tol;

    // geometry
    const seoul = { lat: 37.5665, lng: 126.9780 }, busan = { lat: 35.1796, lng: 129.0756 };
    const km = haversine(seoul, busan) / 1000;
    ok('haversine Seoul–Busan ≈ 325km', near(km, 325, 12), km.toFixed(1)+'km');
    ok('haversine identity = 0', haversine(seoul, seoul) === 0);

    // day grouping
    const D = (y,mo,d,h) => new Date(y,mo,d,h,0,0).getTime();
    ok('dayKey strips time', dayKey(D(2024,4,10,9)) === dayKey(D(2024,4,10,23)));
    ok('dayKey differs across days', dayKey(D(2024,4,10,9)) !== dayKey(D(2024,4,11,9)));

    // trip stats over an injected 2-cluster, 3-day set
    State.photos = []; State.detailList = []; State.geo = []; State.clusters = [];
    const cams = [['Apple','iPhone'],['Samsung','Galaxy']];
    const add = (i, lat, lng, day, hour, cam, fav, rate) => {
      const p = { id:'t'+i, fileName:'x.jpg', timestamp: D(2024,9,10+day,hour),
        hasGps:true, originalGps:{lat,lng}, correctedGps:{lat,lng}, isOutlier:false, direction:null,
        exif:{ make:cams[cam][0], model:cams[cam][1] }, placeName:null, attrs:{memo:'',tags:'',rating:rate||0,fav:!!fav} };
      State.photos.push(p);
    };
    // Seoul day0/1 (9 pts), Busan day2 (4 pts)
    for (let i=0;i<5;i++) add(i, 37.566+i*0.001, 126.978+i*0.001, 0, 9+i, 0, i===0, 5);
    for (let i=0;i<4;i++) add(10+i, 37.570+i*0.001, 126.982+i*0.001, 1, 10+i, 1, false, 0);
    for (let i=0;i<4;i++) add(20+i, 35.179+i*0.001, 129.075+i*0.001, 2, 11+i, 0, true, 4);
    State.detailList = State.photos.slice().sort((a,b)=>a.timestamp-b.timestamp);
    State.geo = State.photos.filter(p=>p.hasGps).sort((a,b)=>a.timestamp-b.timestamp);
    computeClusters();
    ok('computeClusters → 2 clusters (Seoul/Busan)', State.clusters.length === 2, 'got '+State.clusters.length);
    const s = computeTripStats();
    ok('stats total photos = 13', s.totalPhotos === 13, s.totalPhotos);
    ok('stats days = 3', s.days === 3, s.days);
    ok('stats places = 2', s.places === 2, s.places);
    ok('stats distance > 300km', s.distanceKm > 300, s.distanceKm.toFixed(0));
    ok('stats favorites = 5', s.favorites === 5, s.favorites);
    ok('stats has 2 cameras', s.cameras.length === 2, s.cameras.length);
    ok('fmtKm rounds', typeof fmtKm(335.27) === 'string');

    // i18n
    ok('t() default ko', t('stats.title') === '여행 통계', t('stats.title'));
    setLang('en');
    ok('setLang(en) switches', LANG === 'en' && t('stats.title') === 'Travel stats', t('stats.title'));
    ok('t() falls back to key when missing', t('___nope___') === '___nope___');
    setLang('ko');
    ok('setLang(ko) restores', LANG === 'ko' && t('btn.album') === '앨범');

    // i18n key parity (every ko key has an en translation and vice-versa)
    const koK = Object.keys(I18N.ko), enK = Object.keys(I18N.en);
    const missingEn = koK.filter(k => !(k in I18N.en));
    const missingKo = enK.filter(k => !(k in I18N.ko));
    ok('i18n: every KO key has EN', missingEn.length === 0, 'missing EN: '+missingEn.join(', '));
    ok('i18n: every EN key has KO', missingKo.length === 0, 'missing KO: '+missingKo.join(', '));

    globalThis.__report = R;
  })();`;
  try { runInContext(driver, ctx, { filename: 'driver.js' }); }
  catch (e) { ok('pure-logic driver ran', false, e.message); }
  for (const r of (sandbox.__report || [])) results.push(r);
}

// ---- report ----
let failed = 0;
for (const r of results) {
  const tag = r.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`${tag}  ${r.name}${r.pass ? '' : '  — ' + r.detail}`);
  if (!r.pass) failed++;
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
