// Construit cards-index.json : empreinte visuelle (pHash carte entière + illustration) de chaque carte.
// Images : TCGdex d'abord ; à défaut pokemontcg.io ou Limitless (tools/sources.json, même table que l'app).
// Le calcul tourne dans Chrome avec exactement le même code que l'app (tools/cardsig.js).
import puppeteer from "puppeteer-core";
import fs from "fs";

const API = process.env.CARDS_API || "https://api.tcgdex.net/v2/en/cards";
const sigSrc = fs.readFileSync(new URL("./cardsig.js", import.meta.url), "utf8");
const SRC = JSON.parse(fs.readFileSync(new URL("./sources.json", import.meta.url), "utf8"));
const pocket = id => /^(P-A|[AB]\d+[a-z]?)-/.test(id);
const altImgs = (id, loc) => {
  const set = id.slice(0, id.lastIndexOf("-")), out = [];
  const e = SRC.ll[set];
  if (e) {
    const c = typeof e === "string" ? e : e.c;
    let k = (typeof e === "object" && e.m && e.m[loc]) || loc;
    if (/^\d+$/.test(k)) k = String(k).padStart(3, "0");
    // CDN d'abord, puis l'origine (le cache du CDN peut garder une vieille 404 pour les images récentes)
    out.push(`https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${c}/${c}_${k}_R_EN_SM.png`);
    out.push(`https://limitlesstcg.nyc3.digitaloceanspaces.com/tpci/${c}/${c}_${k}_R_EN_SM.png`);
  }
  if (SRC.pt[set]) out.push(`https://images.pokemontcg.io/${SRC.pt[set]}/${loc}.png`);
  return out;
};
// pokemontcg.io renvoie un dos de carte PNG 640×892 au lieu d'une 404 : on l'écarte
const isPlaceholder = b => b.length > 24 && b.readUInt32BE(12) === 0x49484452 && b.readUInt32BE(16) === 640 && b.readUInt32BE(20) === 892;
const lastStatus = {};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getBytes(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(15000), headers: {"user-agent": "Mozilla/5.0 (cote-index)"}});
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      lastStatus[url] = r.status;
      if (r.status === 404 || r.status === 403) return null;
    } catch (e) { lastStatus[url] = String(e.name || e); }
    await sleep(1000 * (t + 1));
  }
  return null;
}

const list = (await (await fetch(API, {signal: AbortSignal.timeout(60000), headers: {"cache-control": "no-cache"}})).json()).filter(c => !pocket(c.id));
console.log("liste :", list.length, "cartes ;", Object.keys(SRC.ll).map(k => k + "=" + list.filter(c => c.id.startsWith(k + "-")).length).join(" "));
// la liste globale de TCGdex oublie certaines cartes (ex. Mew R/G/B du 30e) : on complète avec les sets à source de secours
{
  const have = new Set(list.map(c => c.id));
  for (const set of Object.keys(SRC.ll)) {
    try {
      const j = await (await fetch(API.replace(/\/cards$/, "/sets/") + set, {signal: AbortSignal.timeout(30000), headers: {"cache-control": "no-cache"}})).json();
      console.log(`set ${set} : ${(j.cards || []).length} cartes, ${(j.cards || []).filter(c => !have.has(c.id)).length} ajoutées`);
      for (const c of j.cards || []) if (!have.has(c.id)) { list.push(c); have.add(c.id); }
    } catch (e) {}
  }
}
const browser = await puppeteer.launch({executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"], protocolTimeout: 0});
const page = await browser.newPage();
await page.setContent("<!doctype html><title>index</title>");
await page.evaluate(src => { window.S = new Function(src + "\nreturn CARDSIG;")(); }, sigSrc);

// toutes les images sont téléchargées côté Node, puis empreintes calculées dans Chrome
const rows = [], series = {}; let fail = 0, alt = 0, i = 0;
const jobs = list.map(c => ({c, urls: [...(c.image ? [c.image + "/low.webp"] : []), ...altImgs(c.id, c.localId)]})).filter(j => j.urls.length);
const queue = [], retry = [];
async function fetchJob(j, tries = 4) {
  for (let u = 0; u < j.urls.length; u++) {
    const x = await getBytes(j.urls[u], tries);
    if (x && !isPlaceholder(x)) { j.isAlt = u > 0 || !j.c.image; return x; }
  }
  return null;
}
await Promise.all(Array.from({length: 12}, async () => {
  while (i < jobs.length) {
    const j = jobs[i++];
    const b = await fetchJob(j);
    if (!b) { retry.push(j); continue; }
    queue.push({j, b64: b.toString("base64")});
    if (queue.length >= 100) await flush();
    if ((i % 2000) === 0) console.log(`${i} / ${jobs.length}`);
  }
}));
// seconde passe, lente, pour les images refusées pendant la rafale (CDN qui limite le débit)
console.log(`${retry.length} images à retenter`);
for (const j of retry) {
  await sleep(250);
  const b = await fetchJob(j, 6);
  if (!b) { fail++; if (fail <= 15 || SRC.ll[j.c.id.slice(0, j.c.id.lastIndexOf("-"))]) console.log("échec", j.c.id, j.urls.map(u => u.split("/").pop() + "=" + (lastStatus[u] ?? "?")).join(" ")); continue; }
  queue.push({j, b64: b.toString("base64")});
  if (queue.length >= 100) await flush();
}
await flush();
async function flush() {
  const batch = queue.splice(0, queue.length); if (!batch.length) return;
  const sigs = await page.evaluate(async items => {
    const out = [];
    for (const it of items) {
      try {
        const bin = Uint8Array.from(atob(it.b64), ch => ch.charCodeAt(0));
        const bm = await createImageBitmap(new Blob([bin]));
        const s = S.sig(bm, 0, 0, bm.width, bm.height);
        out.push(S.hex(s.art) + S.hex(s.full));
      } catch (e) { out.push(null); }
    }
    return out;
  }, batch.map(x => ({b64: x.b64})));
  batch.forEach((x, k) => {
    if (!sigs[k]) { fail++; return; }
    const c = x.j.c;
    if (x.j.isAlt) alt++; else { const p = c.image.split("/"); series[c.id.slice(0, c.id.lastIndexOf("-"))] = p[p.length - 3]; }
    rows.push([c.id, c.name, sigs[k]]);
  });
}
await browser.close();
rows.sort((a, b) => a[0].localeCompare(b[0]));
let prev = 0; try { prev = JSON.parse(fs.readFileSync("cards-index.json", "utf8")).cards.length; } catch (e) {}
if (rows.length < prev * 0.95) { console.error(`Index trop petit (${rows.length} contre ${prev}), non publié`); process.exit(1); }
fs.writeFileSync("cards-index.json", JSON.stringify({v: 1, built: new Date().toISOString(), source: "tcgdex en + pokemontcg.io + limitless", series, cards: rows}));
console.log(`index : ${rows.length} cartes (${alt} via sources de secours) sur ${jobs.length} images, ${fail} échecs ; ${list.length - jobs.length} cartes sans aucune image`);
if (rows.length < jobs.length * 0.9) { console.error("Trop d'échecs, index non publié"); process.exit(1); }
