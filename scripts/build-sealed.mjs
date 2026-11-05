// Construit sealed.json : prix du marché de tout ce qui existe autour des cartes Pokémon (ETB, UPC, displays, mini tins, coffrets, accessoires…), en anglais et en japonais
// Source : TCGplayer via TCGCSV (copie quotidienne gratuite, sans clé). Prix en USD, convertis en EUR au taux BCE.
// sealed-history.json garde l'historique quotidien (35 jours) pour calculer les variations 24 h / 7 j / 30 j.
import fs from "fs";

const UA = {"user-agent": "DexScan/1.0 (+https://github.com/sidneydbs/cote)"};
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

// type de produit d'après le nom anglais TCGplayer : tout ce qui existe autour des cartes (scellés, accessoires, goodies)
function typeOf(name) {
  const n = name.toLowerCase();
  if (/code card|online code|digital/.test(n)) return null;
  if (/\bcase\b/.test(n) && !/deck case|display case|carrying case|card case/.test(n)) return "case";
  if (/mini tins? display|mini tin (?:booster )?display|mini tins? \(set|mini tin bundle|mini tins? \[set/.test(n)) return "minitindisp";
  if (/mini tin/.test(n)) return "minitin";
  if (/elite trainer box/.test(n)) return "etb";
  if (/(ultra|super)[ -]premium collection/.test(n)) return "upc";
  if (/booster box|booster display|enhanced booster box|display box/.test(n)) return "display";
  if (/booster bundle/.test(n)) return "bundle";
  if (/blister|checklane|3[- ]pack|three[- ]pack|2[- ]pack|sleeved booster/.test(n)) return "blister";
  if (/booster pack|\bbooster\b|\bpack\b/.test(n) && !/collection|box|tin|bundle/.test(n)) return "booster";
  if (/\btin\b|\btins\b/.test(n)) return "tin";
  if (/build (&|and) battle|prerelease kit/.test(n)) return "bnb";
  if (/premium collection|special collection|deluxe|chest|vault|treasure/.test(n)) return "premium";
  if (/binder|portfolio|album|sleeves?\b|card protectors?|toploader|deck box|deck case|playmat|play mat|dice|\bcoins?\b|damage counter|marker|storage|card case|trainer'?s toolkit|accessor/.test(n)) return "accessoire";
  if (/plush|figure|pin\b|pins\b|poster|keychain|statue|jumbo/.test(n)) return "goodies";
  if (/theme deck|battle deck|league battle|starter deck|\bdeck\b|trainer kit|battle academy|battle arena|world championship/.test(n)) return "deck";
  if (/collection|\bbox\b|gift|bundle|calendar|kit\b|set\b/.test(n)) return "coffret";
  return null;
}
const isCard = p => (p.extendedData || []).some(e => e.name === "Number" || e.name === "Rarity");

// Pokémon (anglais) et Pokémon Japon
const CATS = [{id: 3, lg: "EN"}, {id: 85, lg: "JP"}];
const items = [];
for (const cat of CATS) {
  const base = `https://tcgcsv.com/tcgplayer/${cat.id}`;
  const groups = (await getJSON(`${base}/groups`))?.results || [];
  if (!groups.length) { console.error(`Liste des extensions TCGplayer indisponible (catégorie ${cat.id})`); if (cat.id === 3) process.exit(1); continue; }
  console.log(`${groups.length} extensions TCGplayer (${cat.lg})`);
  for (const g of groups) {
    const prods = (await getJSON(`${base}/${g.groupId}/products`))?.results || []; await sleep(110);
    const sealed = prods.filter(p => !isCard(p)).map(p => ({p, t: typeOf(p.name)})).filter(x => x.t);
    if (!sealed.length) continue;
    const prices = (await getJSON(`${base}/${g.groupId}/prices`))?.results || []; await sleep(110);
    const byId = new Map();
    for (const r of prices) { const cur = byId.get(r.productId); if (!cur || (r.subTypeName === "Normal" && cur.subTypeName !== "Normal")) byId.set(r.productId, r); }
    for (const {p, t} of sealed) {
      const r = byId.get(p.productId); const m = r?.marketPrice ?? r?.midPrice ?? r?.lowPrice ?? null;
      if (!m) continue;
      const x = {i: p.productId, n: p.cleanName || p.name, t, g: g.name, d: (g.publishedOn || "").slice(0, 10), img: p.imageUrl || "", url: p.url || "", m, l: r.lowPrice ?? null, h: r.highPrice ?? null};
      if (r.midPrice != null) x.mid = r.midPrice;
      if (r.directLowPrice != null) x.dl = r.directLowPrice;
      if (cat.lg !== "EN") x.lg = cat.lg;
      items.push(x);
    }
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
