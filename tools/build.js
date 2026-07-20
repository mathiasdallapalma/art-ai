#!/usr/bin/env node
/**
 * Re-packs the editable project back into the single self-contained file that
 * Claude Design originally exported.
 *
 *   node tools/build.js        ->  dist/index.html
 *
 * Every locally-referenced asset (dc-runtime.js, fonts, textures, portraits,
 * artworks) is gzipped, base64'd and inlined into the bundler manifest, and
 * each reference in the markup is swapped for the asset's uuid. The result
 * opens straight from disk with no server and no asset folder.
 *
 * React/ReactDOM are still fetched from unpkg at runtime, exactly as in the
 * original export, so the bundled file does need a network connection.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'index.html');
const SHELL = path.join(__dirname, 'shell.html');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT = path.join(OUT_DIR, 'index.html');

const MIME = {
  '.js': 'text/javascript', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
};
// Text-ish payloads shrink under gzip; JPEG/PNG/woff2 are already compressed,
// so gzipping them only adds CPU and bytes.
const COMPRESS = new Set(['text/javascript', 'image/svg+xml']);

// Stable uuid per file path, so rebuilding an unchanged project is byte-identical.
function uuidFor(rel) {
  const h = crypto.createHash('sha1').update(rel).digest('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}

let html = fs.readFileSync(SRC, 'utf8');

// Collect every local asset reference. Three shapes occur in this project:
// HTML attributes, CSS url(), and single-quoted paths in the component's data
// (portrait:'assets/...', img:'assets/...') — the last is where the artwork
// files live, so omitting it silently ships a bundle with no paintings.
const refs = new Set();
const patterns = [
  /(?:src|href)="((?:assets\/|dc-runtime)[^"]*)"/g,
  /url\((?:&quot;|"|')?((?:assets\/)[^"')&]+)/g,
  /'((?:assets\/)[^']+)'/g,
];
for (const re of patterns) {
  let m;
  while ((m = re.exec(html))) refs.add(m[1]);
}

if (!refs.size) {
  console.error('No local asset references found — is index.html already bundled?');
  process.exit(1);
}

const manifest = {};
let totalRaw = 0, totalPacked = 0, missing = 0;

// Longest path first: replacement is sequential string substitution, so a path
// that is a prefix of another (a/b.jpg vs a/b.jpg.bak) would otherwise corrupt
// the longer one. Current filenames don't collide, but new ones might.
for (const rel of [...refs].sort((a, b) => b.length - a.length || a.localeCompare(b))) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`  MISSING  ${rel}`);
    missing++;
    continue;
  }
  const ext = path.extname(rel).toLowerCase();
  const mime = MIME[ext];
  if (!mime) {
    console.error(`  SKIP     ${rel} (unknown extension ${ext})`);
    continue;
  }
  const raw = fs.readFileSync(abs);
  const compressed = COMPRESS.has(mime);
  const packed = compressed ? zlib.gzipSync(raw, { level: 9 }) : raw;
  const uuid = uuidFor(rel);
  manifest[uuid] = { mime, compressed, data: packed.toString('base64') };
  totalRaw += raw.length;
  totalPacked += packed.length;
  html = html.split(rel).join(uuid);
}

if (missing) {
  console.error(`\n${missing} asset(s) missing — aborting so you don't ship a broken bundle.`);
  process.exit(1);
}

// React/ReactDOM are inlined too, keyed by the unpkg URLs the runtime asks
// for. The loader maps id -> blob only when the uuid has a manifest entry
// (shell.html:279), so leaving these out makes the bundle fetch React over the
// network — and fail outright when opened from file://.
const VENDOR = [
  ['https://unpkg.com/react@18.3.1/umd/react.production.min.js', 'vendor/react.production.min.js'],
  ['https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js', 'vendor/react-dom.production.min.js'],
];
const extResources = VENDOR.map(([id, rel]) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) {
    console.error(`  MISSING  ${rel} (vendored React is required for an offline bundle)`);
    process.exit(1);
  }
  const uuid = uuidFor(rel);
  const packed = zlib.gzipSync(fs.readFileSync(abs), { level: 9 });
  manifest[uuid] = { mime: 'text/javascript', compressed: true, data: packed.toString('base64') };
  return { id, uuid };
});

// These JSON blobs live inside <script> elements, whose content is raw text
// terminated by the first "</script". The template embeds the page's own
// script tags, so its JSON must escape "</" the way the original export did
// (</script>) or the block closes early and JSON.parse sees a truncated
// string. Escaping every "</" is harmless: JSON reads / back as "/".
const safeJson = (v) => JSON.stringify(v).replace(/<\//g, '<\\u002F');

const shell = fs.readFileSync(SHELL, 'utf8');
const out = shell
  .replace('__MANIFEST__', () => safeJson(manifest))
  .replace('__EXT_RESOURCES__', () => safeJson(extResources))
  .replace('__PAGE_ORDER__', () => '[]')
  .replace('__TEMPLATE__', () => safeJson(html));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, out);

const mb = (n) => (n / 1024 / 1024).toFixed(1) + 'MB';
console.log(`Bundled ${Object.keys(manifest).length} assets  ${mb(totalRaw)} raw -> ${mb(totalPacked)} packed`);
console.log(`Wrote ${path.relative(ROOT, OUT)}  ${mb(out.length)}`);
