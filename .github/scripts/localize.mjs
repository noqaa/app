// localize.mjs - runs inside GitHub Actions. It only ever touches ONE project folder (env DIR).
// Options come from <DIR>/.localize.json : { tailwind, assets, scripts }
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';

const log = (...a) => console.log('[localize]', ...a);
const warn = (...a) => console.warn('[localize] WARN', ...a);
const die = (m) => { console.error('[localize] ERROR ' + m); process.exit(1); };

/* ---------- isolation: never leave DIR ---------- */
const ROOT = process.cwd();
const REL = String(process.env.DIR || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
if (!REL || REL.split('/').some((s) => !s || s === '.' || s === '..' || s === '.git' || s === '.github')) die('invalid DIR: ' + REL);
const DIR = path.resolve(ROOT, REL);
if (!DIR.startsWith(ROOT + path.sep) || !fs.existsSync(DIR)) die('folder not found: ' + REL);

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const OPT = { tailwind: false, assets: false, scripts: false, ...readJson(path.join(DIR, '.localize.json'), {}) };
if (!OPT.tailwind && !OPT.assets && !OPT.scripts) { log('all options are off, nothing to do'); process.exit(0); }

/* ---------- helpers ---------- */
const SKIP = new Set(['cdn', 'node_modules', '.git', '.localize']);
const posix = (p) => p.split(path.sep).join('/');
const rd = (f) => fs.readFileSync(f, 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const walk = (d, out = []) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (!SKIP.has(e.name)) walk(p, out); } else out.push(p);
  }
  return out;
};
let touched = false;
const wr = (f, t) => { if (rd(f) !== t) { fs.writeFileSync(f, t); touched = true; log('updated', posix(path.relative(ROOT, f))); } };
async function rewrite(s, re, fn) {
  const m = [...s.matchAll(re)];
  const r = await Promise.all(m.map((x) => fn(...x)));
  let i = 0;
  return s.replace(re, () => r[i++]);
}

/* ---------- HTML helpers (comments and inline script bodies are masked so they are never edited) ---------- */
const TAG = String.raw`(?:"[^"]*"|'[^']*'|[^'">])*`;
function mask(html, scripts = true) {
  const hole = [];
  const put = (s) => '\u0000' + (hole.push(s) - 1) + '\u0000';
  let t = html;
  if (scripts) t = t.replace(new RegExp(`(<script\\b${TAG}>)([\\s\\S]*?)(</script\\s*>)`, 'gi'), (m, a, b, c) => a + put(b) + c);
  t = t.replace(/<!--[\s\S]*?-->/g, put);
  const restore = (s) => { while (s.includes('\u0000')) s = s.replace(/\u0000(\d+)\u0000/g, (m, i) => hole[i]); return s; };
  return { t, restore };
}
const attrs = (tag) => {
  const o = {};
  const b = tag.replace(/^<[\w-]+/, '').replace(/\/?>$/, '');
  for (const m of b.matchAll(/([^\s"'=<>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) o[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return o;
};
const setAttr = (tag, n, v) => tag.replace(new RegExp(`(\\s${n}\\s*=\\s*)(?:"[^"]*"|'[^']*'|[^\\s"'>]+)`, 'i'), (m, p) => p + '"' + v + '"');
const delAttr = (tag, n) => tag.replace(new RegExp(`\\s${n}(?=[\\s>/=]|$)(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+))?`, 'ig'), '');
const unesc = (v) => v.replace(/&amp;/g, '&');
const openOf = (m) => m.match(new RegExp(`^<[\\w-]+\\b${TAG}>`))[0];
const relUrl = (fromDir, rel) => posix(path.relative(fromDir, path.join(DIR, rel)));

/* ---------- which URLs may be localized (APIs, trackers, payment/captcha/map SDKs and anything with keys are never touched) ---------- */
const OWNER = (process.env.GITHUB_REPOSITORY_OWNER || '').toLowerCase();
const PRIVATE = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;
const DENY_HOST = /(^|\.)(googletagmanager\.com|google-analytics\.com|analytics\.google\.com|maps\.googleapis\.com|maps\.google\.com|js\.stripe\.com|paypal\.com|paypalobjects\.com|platform\.twitter\.com|connect\.facebook\.net|apis\.google\.com|accounts\.google\.com|recaptcha\.net|hcaptcha\.com|challenges\.cloudflare\.com|cloudflareinsights\.com|googlesyndication\.com|doubleclick\.net|clarity\.ms|hotjar\.com|segment\.com|intercom\.io|sentry-cdn\.com|paddle\.com)$/i;
const DYNAMIC_Q = /[?&](key|api_?key|token|access_token|auth|signature|sig|callback|jsonp)=/i;
const FILE_EXT = /\.(woff2?|ttf|otf|eot|svg|png|jpe?g|gif|webp|avif|ico|bmp|cur)$/i;
function ok(u, base) {
  try {
    u = String(u).trim();
    if (!u || /^(data|blob|about|javascript|mailto|tel|#)/i.test(u)) return null;
    if (!base && !/^(https?:)?\/\//i.test(u)) return null;
    const x = new URL(u.replace(/^\/\//, 'https://'), base || 'https://placeholder.invalid/');
    if (!/^https?:$/.test(x.protocol)) return null;
    const h = x.hostname;
    if ((PRIVATE.test(h) && !process.env.LOCALIZE_ALLOW_LOCAL) || DENY_HOST.test(h) || (OWNER && h === OWNER + '.github.io') || DYNAMIC_Q.test(x.search)) return null;
    x.hash = '';
    return x;
  } catch { return null; }
}

/* ---------- download engine: cdn/<host>/<path> (same URL = same file, so re-runs never duplicate) ---------- */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
function localName(x, kind) {
  let p; try { p = decodeURIComponent(x.pathname); } catch { p = x.pathname; }
  p = p.replace(/[^\w.@+\-\/]/g, '_').replace(/\/{2,}/g, '/').split('/').map((s) => (s === '.' || s === '..' ? '_' : s)).join('/');
  if (p.endsWith('/')) p += 'index';
  const want = kind === 'css' ? /\.css$/i : kind === 'js' ? /\.m?js$/i : null;
  if (want && !want.test(p)) p += kind === 'css' ? '.css' : '.js';
  if (x.search) { const h = crypto.createHash('sha1').update(x.href).digest('hex').slice(0, 8); const e = path.posix.extname(p); p = p.slice(0, p.length - e.length) + '-' + h + e; }
  return ('cdn/' + x.hostname.replace(/[^\w.-]/g, '_') + (x.port ? '_' + x.port : '') + '/' + p.replace(/^\//, '')).slice(0, 220);
}
async function fetchBuf(u) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(u, { headers: { 'user-agent': UA, accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const b = Buffer.from(await r.arrayBuffer());
      if (b.length > 25 * 1048576) throw new Error('file larger than 25MB');
      return { b, ct: r.headers.get('content-type') || '' };
    } catch (e) { if (i === 2) { warn(u + ' -> ' + e.message + ' (kept the original link)'); return null; } await sleep(1000 * (i + 1)); }
  }
}
const memo = new Map();
const hosts = new Set();
function bring(x, kind) {
  const key = kind + ' ' + x.href;
  if (!memo.has(key)) memo.set(key, (async () => {
    const rel = localName(x, kind), abs = path.join(DIR, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).size > 0) { hosts.add(x.hostname); return rel; }
    const r = await fetchBuf(x.href);
    if (!r) return null;
    if (kind !== 'file' && /text\/html/i.test(r.ct)) { warn('got HTML instead of ' + kind + ', skipped: ' + x.href); return null; }
    let data = r.b;
    if (kind === 'css') data = Buffer.from(await cssUrls(data.toString('utf8'), x.href, path.dirname(abs), 1));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
    touched = true; hosts.add(x.hostname); log('saved', rel);
    return rel;
  })());
  return memo.get(key);
}
async function cssUrls(css, base, fromDir, depth) {
  css = await rewrite(css, /@import\s+(?:url\(\s*)?(["']?)([^"'()\s;]+)\1\s*\)?/gi, async (m, q, u) => {
    const x = depth < 4 && ok(u, base);
    if (!x) return m;
    const rel = await bring(x, 'css');
    return rel ? m.replace(u, () => relUrl(fromDir, rel)) : m;
  });
  return rewrite(css, /url\(\s*(["']?)(?!data:|#)([^"')]+?)\1\s*\)/gi, async (m, q, u) => {
    const [p0, h] = u.split('#');
    const x = ok(p0, base);
    if (!x || !FILE_EXT.test(x.pathname)) return m;
    const rel = await bring(x, 'file');
    return rel ? m.replace(u, () => relUrl(fromDir, rel) + (h ? '#' + h : '')) : m;
  });
}

/* ---------- pages: stylesheets, fonts, images, scripts ---------- */
async function page(f) {
  const dir = path.dirname(f), { t, restore } = mask(rd(f));
  let s = await rewrite(t, new RegExp(`<(link|script|img|source|video)\\b${TAG}>`, 'gi'), async (m, name) => {
    const n = name.toLowerCase(), a = attrs(m);
    const swap = async (attr, kind, needExt) => {
      const x = ok(unesc(a[attr] || ''));
      if (!x || (needExt && !FILE_EXT.test(x.pathname))) return m;
      const rel = await bring(x, kind);
      return rel ? delAttr(delAttr(setAttr(m, attr, relUrl(dir, rel)), 'integrity'), 'crossorigin') : m;
    };
    if (n === 'script') return OPT.scripts && a.src && !/^module$/i.test(a.type || '') ? swap('src', 'js') : m;
    if (n === 'link') {
      const rel = (a.rel || '').toLowerCase(), as = (a.as || '').toLowerCase();
      if (/\bstylesheet\b/.test(rel)) return OPT.assets ? swap('href', 'css') : m;
      if (/\b(preload|prefetch)\b/.test(rel)) {
        if (as === 'style') return OPT.assets ? swap('href', 'css') : m;
        if (as === 'script') return OPT.scripts ? swap('href', 'js') : m;
        if (/font|image/.test(as)) return OPT.assets ? swap('href', 'file', true) : m;
        return m;
      }
      if (/\bicon\b|apple-touch-icon|mask-icon/.test(rel)) return OPT.assets ? swap('href', 'file', true) : m;
      return m;
    }
    if (!OPT.assets) return m;
    let out = m;
    for (const at of ['src', 'poster']) {
      const x = a[at] && ok(unesc(a[at]));
      if (x && FILE_EXT.test(x.pathname)) { const rel = await bring(x, 'file'); if (rel) out = setAttr(out, at, relUrl(dir, rel)); }
    }
    if (a.srcset) {
      const v = await rewrite(unesc(a.srcset), /([^\s,]+)(\s+[\d.]+[wx])?/g, async (mm, u, d) => {
        const x = ok(u);
        if (!x || !FILE_EXT.test(x.pathname)) return mm;
        const rel = await bring(x, 'file');
        return rel ? relUrl(dir, rel) + (d || '') : mm;
      });
      out = setAttr(out, 'srcset', v);
    }
    return out;
  });
  if (OPT.assets) {
    s = await rewrite(s, /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, async (m, a, b, c) => (/text\/tailwindcss/i.test(a) ? m : a + (await cssUrls(b, null, dir, 1)) + c));
    s = await rewrite(s, /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)')/gi, async (m, p, d, q) => {
      const v = d ?? q;
      if (!/url\(/i.test(v)) return m;
      const r = await cssUrls(unesc(v), null, dir, 1);
      return p + (d !== undefined ? '"' + r + '"' : "'" + r + "'");
    });
  }
  if (hosts.size) {
    s = s.replace(new RegExp(`\\s*<link\\b${TAG}>`, 'gi'), (m) => {
      const a = attrs(m);
      if (!/\b(preconnect|dns-prefetch)\b/i.test(a.rel || '')) return m;
      try { return hosts.has(new URL(unesc(a.href || ''), 'https://placeholder.invalid/').hostname) ? '' : m; } catch { return m; }
    });
  }
  wr(f, restore(s));
}

/* ---------- Tailwind: CDN script -> output.css (built from a temporary input.css) ---------- */
const SCR = new RegExp(`<script\\b${TAG}>[\\s\\S]*?</script\\s*>`, 'gi');
const STY = /<style\b[^>]*>[\s\S]*?<\/style\s*>/gi;
function twInfo(U) {
  if (/(^|\/\/)cdn\.tailwindcss\.com/i.test(U)) {
    let pl = [];
    try { pl = (new URL(U.replace(/^\/\//, 'https://')).searchParams.get('plugins') || '').split(',').filter(Boolean); } catch {}
    return { major: 3, ver: (U.match(/\.com\/(\d+\.\d+\.\d+)/) || [])[1], plugins: pl };
  }
  if (/@tailwindcss\/browser/i.test(U)) return { major: 4, ver: (U.match(/browser@(\d+\.\d+\.\d+)/) || [])[1], plugins: [] };
  return null;
}
const merge = (a, b) => { for (const k of Object.keys(b || {})) a[k] = b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && a[k] && typeof a[k] === 'object' ? merge(a[k], b[k]) : b[k]; return a; };
async function tailwind(pages) {
  const stF = path.join(DIR, '.localize', 'tailwind.json');
  const S = readJson(stF, null) || { major: 0, ver: '', plugins: [], config: {}, css: [] };
  const found = [];
  for (const f of pages) {
    const { t, restore } = mask(rd(f), false);
    let info = null; const cfgs = [];
    for (const m of t.match(SCR) || []) {
      const o = openOf(m), a = attrs(o);
      if (a.src) info = info || twInfo(unesc(a.src));
      else { const body = restore(m.slice(o.length, m.lastIndexOf('</'))); if (/^\s*(?:window\.)?tailwind\.config\s*=/.test(body)) cfgs.push(body); }
    }
    if (!info) continue;
    found.push(f);
    S.major = info.major; S.ver = info.ver || S.ver; S.plugins = [...new Set([...S.plugins, ...info.plugins])];
    for (const code of cfgs) {
      const sb = { tailwind: {} }; sb.window = sb;
      try { vm.runInNewContext(code, sb, { timeout: 1000 }); merge(S.config, JSON.parse(JSON.stringify(sb.tailwind.config || {}))); }
      catch (e) { warn('tailwind.config could not be evaluated: ' + e.message); }
    }
    for (const m of t.match(STY) || []) {
      const o = openOf(m);
      if (/text\/tailwindcss/i.test(o)) { const c = restore(m.slice(o.length, m.lastIndexOf('</'))).trim(); if (c && !S.css.includes(c)) S.css.push(c); }
    }
  }
  if (!S.major) { log('no Tailwind CDN script found and no saved state'); return; }

  const TW = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-')), out = path.join(DIR, 'output.css');
  fs.rmSync(out, { force: true }); // never let the old build feed the new one
  const rel = (p) => posix(path.relative(TW, p));
  let pkgs, input, extra = [];
  if (S.major === 3) {
    const plug = { forms: '@tailwindcss/forms@0.5.10', typography: '@tailwindcss/typography@0.5.16', 'aspect-ratio': '@tailwindcss/aspect-ratio@0.4.2', 'container-queries': '@tailwindcss/container-queries@0.1.1' };
    const use = S.plugins.filter((p) => plug[p]);
    pkgs = ['tailwindcss@' + (S.ver || '3.4.17'), ...use.map((p) => plug[p])];
    const conf = { ...S.config, content: [DIR + '/**/*.{html,htm,js}', '!' + DIR + '/cdn/**', '!' + DIR + '/node_modules/**'] };
    fs.writeFileSync(path.join(TW, 'tw.config.cjs'), `const c=${JSON.stringify(conf)};c.plugins=[${use.map((p) => `require('${plug[p].replace(/@[\d.]+$/, '')}')`).join(',')}];module.exports=c;`);
    input = '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n' + S.css.join('\n');
    extra = ['-c', 'tw.config.cjs'];
  } else {
    const v = S.ver && /^4\.([1-9])/.test(S.ver) ? S.ver : '4.1.11';
    pkgs = ['tailwindcss@' + v, '@tailwindcss/cli@' + v];
    input = `@import "tailwindcss" source(none);\n@source "${rel(DIR)}";\n@source not "${rel(DIR)}/cdn";\n` + S.css.join('\n');
  }
  fs.writeFileSync(path.join(TW, 'input.css'), input);
  log('installing', pkgs.join(' '));
  execFileSync('npm', ['install', '--prefix', TW, '--no-audit', '--no-fund', '--loglevel=error', ...pkgs], { stdio: 'inherit' });
  execFileSync('npx', ['--no-install', 'tailwindcss', '-i', 'input.css', '-o', out, '--minify', ...extra], { cwd: TW, stdio: 'inherit' });
  if (!fs.existsSync(out) || !fs.statSync(out).size) die('Tailwind produced an empty output.css');
  touched = true; log('built output.css');

  fs.mkdirSync(path.dirname(stF), { recursive: true });
  const st = JSON.stringify(S, null, 1);
  if (!fs.existsSync(stF) || rd(stF) !== st) fs.writeFileSync(stF, st);

  for (const f of found) { // swap the CDN script for the built stylesheet, drop the inline config and the tailwind <style>
    const r = posix(path.relative(path.dirname(f), DIR)), href = (r ? r + '/' : '') + 'output.css';
    const { t, restore } = mask(rd(f), false);
    const linked = /href\s*=\s*["'][^"']*output\.css/i.test(t);
    let first = !linked;
    let s = t.replace(SCR, (m) => {
      const o = openOf(m), a = attrs(o), U = a.src || '';
      if (twInfo(unesc(U))) { if (first) { first = false; return `<link rel="stylesheet" href="${href}">`; } return ''; }
      if (!U && /^\s*(?:window\.)?tailwind\.config\s*=/.test(restore(m.slice(o.length, m.lastIndexOf('</'))))) return '';
      return m;
    });
    s = s.replace(STY, (m) => (/text\/tailwindcss/i.test(openOf(m)) ? '' : m));
    wr(f, restore(s));
  }
}

/* ---------- housekeeping ---------- */
function gc() { // delete cdn files that nothing references any more (smart updates)
  const cdn = path.join(DIR, 'cdn');
  if (!fs.existsSync(cdn)) return;
  const text = walk(DIR).filter((f) => /\.(html?|css|js|json|webmanifest|svg)$/i.test(f) && path.basename(f) !== 'sw.js').map((f) => rd(f)).join('\n');
  const all = walk(cdn), byRel = new Map(all.map((p) => [posix(path.relative(DIR, p)), p]));
  const keep = new Set();
  for (const [r, p] of byRel) if (text.includes(r)) keep.add(p);
  for (let grow = true; grow;) {
    grow = false;
    for (const p of [...keep]) {
      if (!/\.css$/i.test(p)) continue;
      for (const m of rd(p).matchAll(/(?:url\(\s*["']?|@import\s+["']?)([^"')\s;]+)/gi)) {
        if (/^(data:|https?:|\/\/|#)/i.test(m[1])) continue;
        const q = path.resolve(path.dirname(p), m[1].split(/[?#]/)[0]);
        if (byRel.has(posix(path.relative(DIR, q))) && !keep.has(q)) { keep.add(q); grow = true; }
      }
    }
  }
  for (const p of all) if (!keep.has(p)) { fs.rmSync(p); touched = true; log('removed unused', posix(path.relative(DIR, p))); }
  (function prune(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) if (e.isDirectory()) prune(path.join(d, e.name));
    if (d !== DIR && !fs.readdirSync(d).length) fs.rmdirSync(d);
  })(cdn);
}
function patchSw() { // precache everything so the app works offline from the very first visit
  const f = path.join(DIR, 'sw.js');
  if (!fs.existsSync(f)) return;
  const t = rd(f);
  if (!/SHELL=\[[^\]]*\]/.test(t)) return; // not the template sw.js, leave it alone
  const list = ['./', './index.html', './manifest.webmanifest', './logo.jpg'];
  if (fs.existsSync(path.join(DIR, 'output.css'))) list.push('./output.css');
  for (const p of walk(DIR)) { const r = posix(path.relative(DIR, p)); if (/\.html?$/i.test(r) && r !== 'index.html') list.push('./' + r); }
  const cdn = path.join(DIR, 'cdn');
  if (fs.existsSync(cdn)) for (const p of walk(cdn)) list.push('./' + posix(path.relative(DIR, p)));
  let n = t.replace(/SHELL=\[[^\]]*\]/, () => 'SHELL=' + JSON.stringify(list));
  if (n !== t || touched) n = n.replace(/(C=N\+'-'\+)"[^"]*"/, (m, p) => p + '"' + Date.now().toString(36) + '"');
  wr(f, n);
}

(async () => {
  log('project:', REL, JSON.stringify(OPT));
  const pages = walk(DIR).filter((f) => /\.html?$/i.test(f));
  if (OPT.tailwind) await tailwind(pages);
  if (OPT.assets || OPT.scripts) { for (const f of pages) await page(f); gc(); }
  patchSw();
  log(touched ? 'done, files changed' : 'done, nothing changed');
})().catch((e) => { console.error(e); process.exit(1); });
