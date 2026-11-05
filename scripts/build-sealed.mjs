// Construit sealed.json : prix du marché des produits scellés Pokémon (ETB, UPC, displays, boosters, coffrets…)
// Source : TCGplayer via TCGCSV (copie quotidienne gratuite, sans clé). Prix en USD, convertis en EUR au taux BCE.
// sealed-history.json garde l'historique quotidien (35 jours) pour calculer les variations 24 h / 7 j / 30 j.
import fs from "fs";

const UA = {"user-agent": "DexScan/1.0 (+https://github.com/sidneydbs/cote)"};
const BASE = "https://tcgcsv.com/tcgplayer/3";
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function getJSON(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, {headers: UA, signal: AbortSignal.timeout(30000)});
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch (e) {}
    await sleep(1500 * (t + 1));
  }
  return null;
}
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };

// type de produit d'après le nom anglais TCGplayer
const SKIP = /code card|sleeves?\b|deck box|playmat|binder|portfolio|\bdice\b|\bcoins?\b|\bcase\b|display case|album|pin\b|figure|plush|stadium|card sleeves|toploader/i;
function typeOf(name) {
  if (SKIP.test(name)) return null;
  if (/elite trainer box/i.test(name)) return "etb";
  if (/(ultra|super)[ -]premium collection/i.test(name)) return "upc";
  if (/booster box|booster display|enhanced booster box/i.test(name)) return "display";
  if (/booster bundle/i.test(name)) return "bundle";
  if (/booster pack|sleeved booster|blister|booster\b/i.test(name)) return "booster";
  if (/collection|\bbox\b|\btin\b|premium|chest|gift|bundle/i.test(name)) return "coffret";
  if (/deck/i.test(name)) return "deck";
  return null;
}
const isCard = p => (p.extendedData || []).some(e => e.name === "Number" || e.name === "Rarity");

const groups = (await getJSON(`${BASE}/groups`))?.results || [];
if (!groups.length) { console.error("Liste des extensions TCGplayer indisponible"); process.exit(1); }
console.log(`${groups.length} extensions TCGplayer`);

const items = [];
for (const g of groups) {
  const prods = (await getJSON(`${BASE}/${g.groupId}/products`))?.results || []; await sleep(120);
  const sealed = prods.filter(p => !isCard(p)).map(p => ({p, t: typeOf(p.name)})).filter(x => x.t);
  if (!sealed.length) continue;
  const prices = (await getJSON(`${BASE}/${g.groupId}/prices`))?.results || []; await sleep(120);
  const byId = new Map();
  for (const r of prices) { const cur = byId.get(r.productId); if (!cur || (r.subTypeName === "Normal" && cur.subTypeName !== "Normal")) byId.set(r.productId, r); }
  for (const {p, t} of sealed) {
    const r = byId.get(p.productId); const m = r?.marketPrice ?? r?.midPrice ?? null;
    if (!m) continue;
    items.push({i: p.productId, n: p.cleanName || p.name, t, g: g.name, d: (g.publishedOn || "").slice(0, 10), img: p.imageUrl || "", url: p.url || "", m, l: r.lowPrice ?? null, h: r.highPrice ?? null});
  }
}
console.log(`${items.length} produits scellés cotés`);
const prev = readJSON("sealed.json", null);
if (prev?.items?.length && items.length < prev.items.length * 0.8) { console.error(`Trop peu de produits (${items.length} contre ${prev.items.length}), non publié`); process.exit(1); }

// taux USD → EUR (BCE via Frankfurter), sinon le précédent
let usdEur = prev?.usdEur || null;
for (const u of ["https://api.frankfurter.app/latest?from=USD&to=EUR", "https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR"]) {
  const j = await getJSON(u, 2); if (j?.rates?.EUR) { usdEur = j.rates.EUR; break; }
}
console.log(`taux USD→EUR : ${usdEur}`);

// historique quotidien (prix USD) et variations
const day = new Date().toISOString().slice(0, 10);
const hist = readJSON("sealed-history.json", {days: {}});
hist.days[day] = Object.fromEntries(items.map(x => [x.i, Math.round(x.m * 100) / 100]));
const days = Object.keys(hist.days).sort(); for (const d of days.slice(0, -35)) delete hist.days[d];
const kept = Object.keys(hist.days).sort();
const ago = n => { const t = new Date(Date.parse(day) - n * 864e5).toISOString().slice(0, 10); return [...kept].reverse().find(d => d <= t) || null; };
const ref = {c1: ago(1), c7: ago(7), c30: ago(30)};
for (const x of items) for (const [k, d] of Object.entries(ref)) { const v = d && hist.days[d][x.i]; if (v) x[k] = v; }

fs.writeFileSync("sealed.json", JSON.stringify({v: 1, built: new Date().toISOString(), source: "TCGplayer via TCGCSV", currency: "USD", usdEur, items}));
fs.writeFileSync("sealed-history.json", JSON.stringify(hist));
console.log(`sealed.json : ${items.length} produits · historique ${kept.length} jour(s)`);
