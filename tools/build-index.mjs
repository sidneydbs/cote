// Construit cards-index.json : empreinte visuelle (pHash carte entière + illustration) de chaque carte.
// Images : TCGdex d'abord ; à défaut pokemontcg.io ou Limitless (tools/sources.json, même table que l'app).
// Le calcul tourne dans Chrome avec exactement le même code que l'app (tools/cardsig.js).
import puppeteer from "puppeteer-core";
import fs from "fs";

const API = process.env.CARDS_API || "https://api.tcgdex.net/v2/en/cards";
const sigSrc = fs.readFileSync(new URL("./cardsig.js", import.meta.url), "utf8");
const SRC = JSON.parse(fs.readFileSync(new URL("./sources.json", import.meta.url), "utf8"));
const pocket = id => /^(P-A|[AB]\d+[a-z]?)-/.test(id);
const altImg = (id, loc) => {
  const set = id.slice(0, id.lastIndexOf("-"));
  if (SRC.pt[set]) return `https://images.pokemontcg.io/${SRC.pt[set]}/${loc}.png`;
  if (SRC.ll[set]) { const c = SRC.ll[set]; return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${c}/${c}_${String(loc).padStart(3, "0")}_R_EN_SM.png`; }
  return null;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getBytes(url) {
  for (let t = 0; t < 4; t++) {
    try { const r = await fetch(url, {signal: AbortSignal.timeout(15000)}); if (r.ok) return Buffer.from(await r.arrayBuffer()); if (r.status === 404) return null; } catch (e) {}
    await sleep(1000 * (t + 1));
  }
  return null;
}

const list = (await (await fetch(API, {signal: AbortSignal.timeout(60000)})).json()).filter(c => !pocket(c.id));
const browser = await puppeteer.launch({executablePath: process.env.CHROME || "/usr/bin/google-chrome", args: ["--no-sandbox"], protocolTimeout: 0});
const page = await browser.newPage();
await page.setContent("<!doctype html><title>index</title>");
await page.evaluate(src => { window.S = new Function(src + "\nreturn CARDSIG;")(); }, sigSrc);

// toutes les images sont téléchargées côté Node, puis empreintes calculées dans Chrome
const rows = [], series = {}; let fail = 0, alt = 0, i = 0;
const jobs = list.map(c => ({c, url: c.image ? c.image + "/low.webp" : altImg(c.id, c.localId), isAlt: !c.image})).filter(j => j.url);
const queue = [];
await Promise.all(Array.from({length: 12}, async () => {
  while (i < jobs.length) {
    const j = jobs[i++];
    const b = await getBytes(j.url);
    if (!b) { fail++; continue; }
    queue.push({j, b64: b.toString("base64")});
    if (queue.length >= 100) await flush();
    if ((i % 2000) === 0) console.log(`${i} / ${jobs.length}`);
  }
}));
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
fs.writeFileSync("cards-index.json", JSON.stringify({v: 1, built: new Date().toISOString(), source: "tcgdex en + pokemontcg.io + limitless", series, cards: rows}));
console.log(`index : ${rows.length} cartes (${alt} via sources de secours) sur ${jobs.length} images, ${fail} échecs ; ${list.length - jobs.length} cartes sans aucune image`);
if (rows.length < jobs.length * 0.9) { console.error("Trop d'échecs, index non publié"); process.exit(1); }
