// Resolves public-domain artwork images from Wikipedia/Wikimedia Commons.
// Resumable: already-downloaded files are skipped, so re-running after a
// rate-limit stop picks up where it left off.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const UA = 'ArtAI-prototype/1.0 (mdpat9600@gmail.com)';
const WIDTH = 1000;
const MANIFEST = path.join(ROOT, 'tools', 'art-manifest.json');

const ARTISTS = [
  { id: 0, key: 'van-gogh', portrait: 'Vincent van Gogh',
    works: ['The Starry Night','Wheat Field with Cypresses','Almond Blossoms','The Yellow House',
            'Irises (painting)','The Night Café','Wheatfield with Crows','Portrait of Dr. Gachet',
            'Café Terrace at Night'] },
  { id: 1, key: 'monet', portrait: 'Claude Monet',
    works: ['Impression, Sunrise','Water Lilies (Monet series)','Bridge over a Pond of Water Lilies',
            'Haystacks (Monet series)','Poplars (Monet series)','Rouen Cathedral (Monet series)',
            'Woman with a Parasol','The Artist\'s Garden at Giverny','The Magpie (Monet)'] },
  { id: 2, key: 'hokusai', portrait: 'Hokusai',
    works: ['The Great Wave off Kanagawa','Fine Wind, Clear Morning','Kajikazawa in Kai Province',
            'Ejiri in Suruga Province','Rainstorm Beneath the Summit','Tama River in Musashi Province',
            'Sundai, Edo','Amida Falls','Cushion Pine at Aoyama'] },
  { id: 3, key: 'vermeer', portrait: 'Johannes Vermeer',
    works: ['Girl with a Pearl Earring','The Milkmaid (Vermeer)','Girl Reading a Letter at an Open Window',
            'The Geographer','The Lacemaker (Vermeer)','Woman with a Lute','The Art of Painting',
            'View of Delft','Woman Holding a Balance'] },
  { id: 4, key: 'turner', portrait: 'J. M. W. Turner',
    works: ['The Fighting Temeraire','Rain, Steam and Speed','Snow Storm: Steam-Boat off a Harbour\'s Mouth',
            'The Slave Ship','Norham Castle, Sunrise','Dido building Carthage',
            'The Burning of the Houses of Lords and Commons','Ulysses Deriding Polyphemus','Chichester Canal'] },
  { id: 5, key: 'klimt', portrait: 'Gustav Klimt',
    works: ['Portrait of Adele Bloch-Bauer I','The Kiss (Klimt)','Danaë (Klimt)','Stoclet Frieze',
            'Water Serpents I','Birch Forest (Klimt)','Portrait of Adele Bloch-Bauer II',
            'Judith and the Head of Holofernes','Death and Life'] },
];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Wikimedia returns 429 under sustained load; back off and retry rather than
// hammering (and rather than losing progress).
async function fetchRetry(url, tries = 5) {
  let wait = 2000;
  for (let t = 1; t <= tries; t++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res;
    if (res.status === 429 || res.status >= 500) {
      console.log(`    ${res.status}, retry ${t}/${tries} in ${wait / 1000}s`);
      await sleep(wait);
      wait *= 2;
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }
  throw new Error('retries exhausted');
}

const json = async (u) => (await fetchRetry(u)).json();

async function leadImage(title) {
  const u = 'https://en.wikipedia.org/w/api.php?action=query&format=json&redirects=1'
    + `&prop=pageimages&piprop=original|thumbnail&pithumbsize=${WIDTH}&titles=`
    + encodeURIComponent(title);
  const j = await json(u);
  for (const p of Object.values(j?.query?.pages || {})) {
    if (p.missing !== undefined) continue;
    const src = p.thumbnail?.source || p.original?.source;
    if (src) return { src, resolved: p.title };
  }
  return null;
}

async function commonsSearch(query, skip = new Set()) {
  const u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json'
    + '&generator=search&gsrnamespace=6&gsrlimit=8&gsrsearch=' + encodeURIComponent(query)
    + `&prop=imageinfo&iiprop=url|size&iiurlwidth=${WIDTH}`;
  const j = await json(u);
  const pages = Object.values(j?.query?.pages || {}).sort((a, b) => (a.index || 99) - (b.index || 99));
  for (const p of pages) {
    if (!/\.(jpe?g|png)$/i.test(p.title)) continue;
    const ii = p.imageinfo?.[0];
    if (!ii?.thumburl || skip.has(ii.thumburl)) continue;
    return { src: ii.thumburl, resolved: p.title };
  }
  return null;
}

async function download(src, file) {
  const res = await fetchRetry(src);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(ROOT, file), buf);
  return buf.length;
}

(async () => {
  const out = fs.existsSync(MANIFEST)
    ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8'))
    : { portraits: {}, works: {} };
  const failures = [];
  const seen = new Set();
  for (const v of [...Object.values(out.portraits), ...Object.values(out.works)]) {
    if (v.source) seen.add(v.source);
  }

  // Resolve one slot: lead image first, Commons search on miss or on a
  // duplicate (redirects can collapse two queries onto the same article).
  async function resolve(query, artistName) {
    let r = await leadImage(query);
    if (!r || seen.has(r.resolved)) {
      const alt = await commonsSearch(`${query} ${artistName}`);
      if (alt && !seen.has(alt.resolved)) r = alt;
    }
    return r && !seen.has(r.resolved) ? r : null;
  }

  const save = () => fs.writeFileSync(MANIFEST, JSON.stringify(out, null, 2));

  for (const a of ARTISTS) {
    if (!out.portraits[a.key]) {
      const r = await resolve(a.portrait, a.portrait);
      if (r) {
        const ext = (r.src.match(/\.(jpe?g|png)/i) || ['.jpg'])[0].toLowerCase().replace('jpeg', 'jpg');
        const file = `assets/portraits/${a.key}${ext}`;
        const n = await download(r.src, file);
        out.portraits[a.key] = { file, source: r.resolved, bytes: n };
        seen.add(r.resolved);
        save();
        console.log(`OK  portrait ${a.key} <- ${r.resolved} (${Math.round(n / 1024)}KB)`);
      } else { failures.push(`portrait ${a.key}`); console.log(`ERR portrait ${a.key}`); }
      await sleep(400);
    }

    for (let i = 0; i < a.works.length; i++) {
      const slot = `${a.id}-${i}`;
      if (out.works[slot]) continue;
      const title = a.works[i];
      const r = await resolve(title, a.portrait);
      if (r) {
        const ext = (r.src.match(/\.(jpe?g|png)/i) || ['.jpg'])[0].toLowerCase().replace('jpeg', 'jpg');
        const file = `assets/works/${a.key}-${String(i + 1).padStart(2, '0')}${ext}`;
        const n = await download(r.src, file);
        out.works[slot] = { file, query: title, source: r.resolved, bytes: n };
        seen.add(r.resolved);
        save();
        console.log(`OK  ${a.key}-${i + 1} <- ${r.resolved} (${Math.round(n / 1024)}KB)`);
      } else { failures.push(`${slot} (${title})`); console.log(`ERR ${slot} ${title}`); }
      await sleep(400);
    }
  }

  save();
  console.log('\nFailures:', failures.length ? failures.join(', ') : 'none');
})();
