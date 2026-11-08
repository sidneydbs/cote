// Construit cm-sealed.json : prix Cardmarket (marché européen, la France en tête) de tous les produits scellés Pokémon.
// Source : fichiers publics quotidiens de Cardmarket (catalogue + guide des prix), sans clé.
//   avg  = prix moyen des ventes conclues · low = annonce la moins chère en ce moment · trend = tendance
//   avg1 / avg7 / avg30 = moyenne des ventes sur 1, 7 et 30 jours
// Chaque produit est relié, quand c'est possible, au même produit TCGplayer (sealed.json) pour l'image et le prix américain.
import fs from "fs";

const UA = {"user-agent": "DexScan/1.0 (+https://github.com/sidneydbs/cote)"};
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try { const r = await fetch(url, {headers: UA, signal: AbortSignal.timeout(60000)}); if (r.ok) return await r.json(); }
    catch (e) { console.error(String(e)); }
    await sleep(2000 * (t + 1));
  }
  return null;
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };

const BASE = "https://downloads.s3.cardmarket.com/productCatalog";
const cat = await getJSON(`${BASE}/productList/products_nonsingles_6.json`);
const pg = await getJSON(`${BASE}/priceGuide/price_guide_6.json`);
if (!cat?.products?.length || !pg?.priceGuides?.length) { console.error("Fichiers Cardmarket indisponibles"); process.exit(1); }
console.log(`catalogue : ${cat.products.length} produits (${cat.createdAt}) · guide des prix : ${pg.priceGuides.length} (${pg.createdAt})`);
const cats = {}; for (const p of cat.products) cats[p.categoryName] = (cats[p.categoryName] || 0) + 1;
console.log("catégories :", JSON.stringify(cats));

function typeOf(name, c) {
  const n = name.toLowerCase(), k = (c || "").toLowerCase();
  if (/code card|online code/.test(n)) return null;
  if (/mini tin.*display|display.*mini tin/.test(n)) return "minitindisp";
  if (/mini tin/.test(n)) return "minitin";
  if (/elite trainer/.test(k + " " + n)) return "etb";
  if (/(ultra|super)[ -]?premium/.test(n)) return "upc";
  if (/display|booster box/.test(k + " " + n) && !/case/.test(n)) return "display";
  if (/booster bundle|\bbundle\b/.test(n)) return "bundle";
  if (/blister|3[- ]?pack|three[- ]pack|2[- ]pack|checklane/.test(n) || /blister/.test(k)) return "blister";
  if (/\btins?\b/.test(k + " " + n)) return "tin";
  if (/build (&|and) battle|prerelease|avant-premi/.test(n)) return "bnb";
  if (/booster/.test(k) && !/box|display|bundle/.test(n)) return "booster";
  if (/premium collection|special collection|deluxe|chest|vault/.test(n)) return "premium";
  if (/deck|trainer kit|battle academy|battle arena/.test(k + " " + n)) return "deck";
  if (/\bcase\b/.test(n)) return "case";
  if (/coin|sleeve|binder|album|playmat|deck box|toploader|dice|marker|portfolio/.test(k + " " + n)) return "accessoire";
  if (/collection|box|set|kit|gift/.test(k + " " + n)) return "coffret";
  return "autre";
}
const pr = new Map(pg.priceGuides.map(x => [x.idProduct, x]));
const r2 = v => v == null ? undefined : Math.round(v * 100) / 100;

// rapprochement avec TCGplayer (nom anglais, même type)
const tp = readJSON("sealed.json", {items: []}).items.filter(x => !x.lg);
const toks = s => new Set(s.toLowerCase().replace(/pok[eé]mon|tcg|the|and|&|scarlet|violet|sword|shield|mega evolution/g, " ").replace(/booster box/g, "display").replace(/[^a-z0-9]+/g, " ").split(" ").filter(w => w.length > 1));
const tpIdx = tp.map(x => ({x, k: toks(x.n + " " + (x.g || "").replace(/^[A-Z0-9]+:\s*/, ""))}));
function match(name, t) {
  const a = toks(name); let best = null, bs = 0;
  for (const {x, k} of tpIdx) {
    if (x.t !== t) continue;
    let inter = 0; for (const w of a) if (k.has(w)) inter++;
    const s = inter / Math.max(a.size, 1);
    if (s > bs) { bs = s; best = x; }
  }
  return bs >= .75 ? best : null;
}

const items = [];
for (const p of cat.products) {
  const t = typeOf(p.name, p.categoryName); if (!t) continue;
  const g = pr.get(p.idProduct); if (!g || (g.avg == null && g.trend == null && g.low == null)) continue;
  const x = {i: p.idProduct, n: p.name, t, c: p.categoryName.replace(/^Pok[eé]mon /, ""), e: p.idExpansion, d: (p.dateAdded || "").slice(0, 10),
    a: r2(g.avg), lo: r2(g.low), tr: r2(g.trend), a1: r2(g.avg1), a7: r2(g.avg7), a30: r2(g.avg30)};
  const m = match(p.name, t); if (m) { x.tp = m.i; if (m.img) x.img = m.img; }
  items.push(x);
}
console.log(`${items.length} produits cotés · ${items.filter(x => x.tp).length} reliés à TCGplayer`);
const prev = readJSON("cm-sealed.json", null);
if (prev?.items?.length && items.length < prev.items.length * .8) { console.error(`Trop peu de produits (${items.length} contre ${prev.items.length}), non publié`); process.exit(1); }
fs.writeFileSync("cm-sealed.json", JSON.stringify({v: 1, built: new Date().toISOString(), pg: pg.createdAt, source: "Cardmarket", currency: "EUR", cats, items}));
console.log("cm-sealed.json écrit");
