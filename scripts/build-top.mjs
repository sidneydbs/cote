// Top 100 des cartes à chasser : toutes les cartes rares (hors Commune, Peu Commune, Sans rareté) de toutes les extensions,
// avec leur cote Cardmarket relue chez TCGdex. Trois classements de 100 cartes :
//  - chasse : les cartes qui valent le plus ET qui montent (valeur × élan des ventes sur 7 j par rapport à 30 j)
//  - valeur : les plus chères
//  - hausse : les plus fortes hausses sur 30 jours (cartes à 10 € et plus)
// La valeur retenue est la médiane (tendance, moyenne 7 j, moyenne 30 j) : un seul achat isolé ne fausse pas le classement.
// Une cote Cardmarket incohérente (moins du quart du prix TCGplayer, cartes mal reliées) est remplacée par le prix TCGplayer en €.
// Sortie : top.json { v, built, usdEur, n, chasse:[…], valeur:[…], hausse:[…] }
import fs from "node:fs";

const API = "https://api.tcgdex.net/v2";
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(45000), headers: {"cache-control": "no-cache", "user-agent": "cote-top"}});
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(1200 * (i + 1));
  }
  return null;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({length: n}, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

const RA = JSON.parse(fs.readFileSync("rarities.json", "utf8"));
let usdEur = 0.87;
try { usdEur = JSON.parse(fs.readFileSync("sealed.json", "utf8")).usdEur || usdEur; } catch (e) {}
const SKIP = new Set(["Commune", "Peu Commune", "Sans Rareté", "Sans rareté"]);
const cand = [];
for (const [sid, s] of Object.entries(RA.S)) for (const [ri, nums] of s.g) {
  const r = RA.R[ri]; if (SKIP.has(r)) continue;
  for (const n of String(nums).split(",")) if (n) cand.push({id: `${sid}-${n}`, sid, n, r, sn: s.n, d: s.d});
}
console.log("cartes à relire :", cand.length);

const num = x => typeof x === "number" && x > 0 ? x : null;
const med = l => { const a = l.filter(x => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor((a.length - 1) / 2)] : null; };
const out = [];
let done = 0, priced = 0, fixed = 0;
await pool(cand, 10, async c => {
  const k = await get(`${API}/fr/cards/${encodeURIComponent(c.id)}`) || await get(`${API}/en/cards/${encodeURIComponent(c.id)}`);
  if (++done % 1000 === 0) console.log(done, "/", cand.length);
  const p = k?.pricing; if (!p) return;
  const cm = p.cardmarket || {}, tp = p.tcgplayer || {};
  // variante principale : la carte normale, sinon la version holo
  const s = (num(cm.trend) || num(cm.avg) || num(cm.avg7)) ? "" : "-holo";
  let tr = num(cm["trend" + s]), a1 = num(cm["avg1" + s]), a7 = num(cm["avg7" + s]), a30 = num(cm["avg30" + s]);
  let v = med([tr, a7, a30]), src = "cm";
  const usd = Math.max(0, ...Object.values(tp).filter(x => x && typeof x === "object").map(x => x.marketPrice ?? x.midPrice ?? 0));
  const tE = usd * usdEur;
  if (tE >= 1 && (v == null || v < tE / 4)) { if (v != null) fixed++; v = Math.round(tE * 100) / 100; tr = v; a1 = a7 = a30 = null; src = "tp"; }
  if (v == null || v < 1) return;
  priced++;
  const chg = a7 && a30 ? a7 / a30 - 1 : null;
  out.push({id: c.id, n: k.name || c.id, s: c.sid, sn: c.sn, no: k.localId || c.n, of: k.set?.cardCount?.official || null, r: c.r, d: c.d,
    img: k.image || null, v: Math.round(v * 100) / 100, a1, a7, a30, chg: chg == null ? null : Math.round(chg * 1000) / 1000, src});
});
console.log("cartes cotées :", priced, "· cotes corrigées :", fixed);
if (priced < 2000) { console.error("Trop peu de cartes cotées, rien n'est publié"); process.exit(1); }

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
// chasse : valeur (échelle logarithmique) × élan ; une carte sans historique 30 j compte comme stable
const score = x => Math.log10(x.v) * (1 + clamp(x.chg ?? 0, -0.4, 0.8)) + (x.a1 ? 0.05 : 0);
const pick = l => l.slice(0, 100).map((x, i) => ({...x, k: i + 1}));
const chasse = pick(out.filter(x => x.v >= 15).map(x => ({...x, sc: Math.round(score(x) * 1000) / 1000})).sort((a, b) => b.sc - a.sc));
const valeur = pick([...out].sort((a, b) => b.v - a.v));
const hausse = pick(out.filter(x => x.v >= 10 && x.chg != null && x.a30 >= 5).sort((a, b) => b.chg - a.chg));
fs.writeFileSync("top.json", JSON.stringify({v: 1, built: new Date().toISOString(), usdEur, n: priced, chasse, valeur, hausse}));
console.log("top.json :", (fs.statSync("top.json").size / 1024).toFixed(0), "Ko");
console.log("chasse :", chasse.slice(0, 10).map(x => `${x.n} (${x.sn}) ${x.v}€ ${x.chg}`).join(" | "));
