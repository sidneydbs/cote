// Cotes de toutes les cartes, en un seul fichier : l'app affiche les prix d'une extension d'un coup,
// au lieu de demander la fiche de chaque carte une par une à TCGdex (jusqu'à 300 requêtes par extension).
// Relu 9 fois par jour par GitHub (8 h, 10 h, 12 h, 15 h, 18 h, 20 h, 23 h, 2 h, 5 h, heure de Paris). Même calcul que l'app : fiche FR (sinon EN), variante principale,
// cote Cardmarket incohérente remplacée par le prix TCGplayer en € (extensions Écarlate et Violet / Méga-Évolution).
// Sortie : prices.json { v, built, n, p: { idExtension: { numéro: [cote, moy. 1 j, moy. 7 j, moy. 30 j] | 0 } } }
//   + history/<idExtension>.json : la cote de chaque jour, pour les courbes de l'app.
//   0 = carte relue, sans cote.
import fs from "node:fs";

const API = "https://api.tcgdex.net/v2";
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(45000), headers: {"cache-control": "no-cache", "user-agent": "cote-prices"}});
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(1200 * (i + 1));
  }
  return undefined;   // échec réseau (≠ carte absente)
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({length: n}, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}

let usdEur = 0.87;
try { usdEur = JSON.parse(fs.readFileSync("sealed.json", "utf8")).usdEur || usdEur; } catch (e) {}

/* --- copie des fonctions de l'app (index.html) --- */
function hasPrice(p){ return !!(p && ((p.cardmarket && (p.cardmarket.trend!=null||p.cardmarket["trend-holo"]!=null||p.cardmarket.avg!=null)) || (p.tcgplayer && Object.keys(p.tcgplayer).some(k=>typeof p.tcgplayer[k]==="object")))); }
// cote gonflée par quelques ventes très chères sur une carte peu vendue : même règle que l'app (sanePricing)
function sanePricing(d){
  const p = d?.pricing, cm = p?.cardmarket; if(!cm || cm._tp) return d;
  const tp = p.tcgplayer || {}, px = k => { const v = tp[k]; return v && typeof v==="object" ? (v.marketPrice ?? v.midPrice ?? 0) : 0; };
  // marché US de la même version : normale ↔ normal / holofoil, reverse ↔ reverse-holofoil
  const usOf = s => (s ? (px("reverse-holofoil") || px("holofoil")) : (px("normal") || px("holofoil") || px("unlimited") || px("unlimitedHolofoil"))) * usdEur;
  for(const s of ["", "-holo"]){
    const t = cm["trend"+s], a1 = cm["avg1"+s], lo = cm["low"+s];
    if(!(t >= 30) || !(a1 > 0) || !(lo > 0)) continue;
    const tE = usOf(s), ref = Math.max(a1, lo, tE >= 1 ? tE : 0);
    if(ref >= 5 && t > 4*ref){ const v = Math.round(ref*100)/100; (cm._unsure ||= []).push({v: s || "normale", was: t, now: v, a1, lo, us: tE >= 1 ? Math.round(tE*100)/100 : null}); cm["trend"+s] = v; }
  }
  return d;
}
/* TCGdex relie souvent deux cartes différentes à la même fiche Cardmarket (version holo et non holo du même Pokémon, numéros H des
   séries e-Card, étoiles brillantes…) : la cote reçue est alors celle de l'autre carte. Audit du 16/11/2026 : 730 fiches partagées,
   ex. Pikachu ☆ 104/110 affiché 6 € pour 6 300 € aux États-Unis. Si la cote Europe et le marché US de la même version diffèrent de
   plus de 4 fois, on retient le marché US converti en euros, et la fiche le dit. */
function usPricing(d){
  const p = d?.pricing, cm = p?.cardmarket, tp = p?.tcgplayer; if(!cm || !tp || cm._tp) return d;
  const px = k => { const v = tp[k]; return v && typeof v==="object" ? (v.marketPrice ?? v.midPrice ?? 0) : 0; };
  const us = (px("normal") || px("holofoil") || px("unlimited") || px("unlimitedHolofoil")) * usdEur, eu = cm.trend ?? cm.avg;
  if(!(us >= 5) || !(eu > 0) || (cm._unsure && cm._unsure.length)) return d;
  if(eu < us/4 || eu > us*4){
    const v = Math.round(us*100)/100, info = {v:"normale", was:eu, now:v, us:v, kind:"us"};
    (cm._unsure ||= []).push(info);
    cm.trend = v;
  }
  return d;
}
function fixPricing(d){
  sanePricing(d); usPricing(d);
  const p = d?.pricing, cm = p?.cardmarket, tp = p?.tcgplayer;
  if(!cm || !tp || cm._tp) return d;
  const sid = d.set?.id || String(d.id||"").replace(/-[^-]+$/,""); if(!/^(me|sv)/.test(sid)) return d;
  const usd = Math.max(0, ...Object.values(tp).filter(v=>v && typeof v==="object").map(v=>v.marketPrice ?? v.midPrice ?? 0));
  const tE = usd * usdEur;
  const m = Math.max(0, ...["trend","avg","avg7","trend-holo","avg-holo","avg7-holo"].map(k=>typeof cm[k]==="number" ? cm[k] : 0));
  if(tE >= 1 && m < tE/4){ const v = Math.round(tE*100)/100; p.cardmarket = {updated: tp.updated || cm.updated, unit:"EUR", trend:v, avg:v, _tp:true}; }
  return d;
}
function cmVal(cm,k,suf){ const x = cm?.[k+suf]; return typeof x==="number" && x>0 ? x : null; }
function cmVariants(card){
  const cm = card?.pricing?.cardmarket; if(!cm) return [];
  const out = [];
  if(cmVal(cm,"trend","")||cmVal(cm,"avg","")) out.push({key:""});
  if(cmVal(cm,"trend","-holo")||cmVal(cm,"avg","-holo")) out.push({key:"-holo"});
  return out;
}
function marketInfo(card){
  const cm = card?.pricing?.cardmarket; const vs = cmVariants(card); if(!cm||!vs.length) return null;
  const s = vs[0].key;
  return {p: cmVal(cm,"trend",s) ?? cmVal(cm,"avg",s) ?? cmVal(cm,"avg7",s), a1: cmVal(cm,"avg1",s), a7: cmVal(cm,"avg7",s), a30: cmVal(cm,"avg30",s)};
}

const RA = JSON.parse(fs.readFileSync("rarities.json", "utf8"));
const cand = [];
for (const [sid, s] of Object.entries(RA.S)) for (const [, nums] of s.g)
  for (const n of String(nums).split(",")) if (n) cand.push({sid, n});
console.log("cartes à relire :", cand.length);

const r2 = x => x == null ? null : Math.round(x * 100) / 100;
const P = {};
// rapport d'audit (prices-audit.json) : cotes corrigées ou suspectes, extension par extension
const A = {fixed: [], tp: [], gap: [], nocm: []}, byProd = new Map();
function audit(sid, n, d){
  const cm = d?.pricing?.cardmarket, tp = d?.pricing?.tcgplayer, name = d?.name || "";
  const row = x => ({set: sid, n, name, ...x});
  if (!cm) { if (tp) A.nocm.push(row({})); return; }
  if (cm._unsure) for (const u of cm._unsure) A.fixed.push(row(u));
  if (cm._tp) A.tp.push(row({now: cm.trend}));
  if (cm.idProduct) { const k = cm.idProduct; (byProd.get(k) || byProd.set(k, []).get(k)).push(`${sid}-${n} ${name}`); }
  // écart Europe / États-Unis : même version, les deux prix au-dessus de 5 €
  if (tp && !cm._tp && !cm._unsure) {
    const px = k => { const v = tp[k]; return v && typeof v === "object" ? (v.marketPrice ?? v.midPrice ?? 0) : 0; };
    const us = (px("normal") || px("holofoil") || px("unlimited") || px("unlimitedHolofoil")) * usdEur, eu = cm.trend;
    if (us >= 5 && eu >= 5 && (eu > 4 * us || us > 4 * eu)) A.gap.push(row({eu: r2(eu), us: r2(us), x: r2(Math.max(eu / us, us / eu))}));
  }
}
let done = 0, priced = 0, failed = 0;
await pool(cand, 12, async c => {
  const id = encodeURIComponent(`${c.sid}-${c.n}`);
  let d = await get(`${API}/fr/cards/${id}`);
  if (d) fixPricing(d);
  if (!d || !hasPrice(d.pricing)) {
    const en = await get(`${API}/en/cards/${id}`);
    if (en) { fixPricing(en); if (!d) d = en; else if (hasPrice(en.pricing)) d.pricing = en.pricing; }
    else if (en === undefined && d === undefined) { failed++; return; }   // rien pu lire : la carte reste lue par l'app
  }
  if (++done % 2000 === 0) console.log(done, "/", cand.length);
  if (d) audit(c.sid, c.n, d);
  const mi = d ? marketInfo(d) : null;
  (P[c.sid] ||= {})[c.n] = mi?.p ? (() => { const a = [r2(mi.p), r2(mi.a1), r2(mi.a7), r2(mi.a30)]; while (a.length > 1 && a[a.length - 1] == null) a.pop(); return a; })() : 0;
  if (mi?.p) priced++;
});
console.log("cartes cotées :", priced, "· échecs réseau :", failed);
if (priced < 5000) { console.error("Trop peu de cartes cotées, rien n'est publié"); process.exit(1); }
fs.writeFileSync("prices.json", JSON.stringify({v: 1, built: new Date().toISOString(), n: priced, p: P}));
console.log("prices.json :", (fs.statSync("prices.json").size / 1024).toFixed(0), "Ko");
// historique jour par jour : history/<extension>.json { v: 1, d0: "AAAA-MM-JJ", p: { numéro: [cote en centimes, un nombre par jour depuis d0] } }
//   null = pas de cote ce jour-là. Relancé 9 fois par jour : seule la case du jour est réécrite, le fichier ne change que si la cote bouge.
//   Une carte non relue (échec réseau) garde ses jours précédents.
{
  const day = new Date().toISOString().slice(0, 10), dn = s => Math.round(Date.parse(s + "T00:00:00Z") / 864e5);
  fs.mkdirSync("history", {recursive: true});
  let files = 0, kb = 0;
  for (const [sid, cards] of Object.entries(P)) {
    const f = `history/${sid}.json`;
    let h = null; try { h = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) {}
    if (!h || h.v !== 1 || !h.d0) h = {v: 1, d0: day, p: {}};
    const i = dn(day) - dn(h.d0); if (i < 0) continue;
    for (const [n, a] of Object.entries(cards)) {
      const c = a ? Math.round(a[0] * 100) : null, row = h.p[n] || [];
      if (c == null && !row.length) continue;
      while (row.length < i) row.push(null);
      row[i] = c; h.p[n] = row;
    }
    if (!Object.keys(h.p).length) continue;
    const txt = JSON.stringify(h); fs.writeFileSync(f, txt); files++; kb += txt.length / 1024;
  }
  console.log("historique :", files, "extensions,", kb.toFixed(0), "Ko");
}
// même fiche Cardmarket reliée à plusieurs cartes différentes : au moins une des cotes est celle d'une autre carte
const dup = [...byProd.entries()].filter(([, l]) => l.length > 1).map(([id, l]) => ({idProduct: id, cards: l}));
const bySet = {}; for (const k of ["fixed", "tp", "gap"]) for (const r of A[k]) ((bySet[r.set] ||= {fixed: 0, tp: 0, gap: 0, dup: 0})[k])++;
for (const d of dup) { const sid = d.cards[0].split(" ")[0].replace(/-[^-]+$/, ""); (bySet[sid] ||= {fixed: 0, tp: 0, gap: 0, dup: 0}).dup += d.cards.length; }
fs.writeFileSync("prices-audit.json", JSON.stringify({built: new Date().toISOString(), cards: done, priced,
  total: {fixed: A.fixed.length, tp: A.tp.length, gap: A.gap.length, dup: dup.length, nocm: A.nocm.length},
  bySet, fixed: A.fixed, tp: A.tp, gap: A.gap.sort((a, b) => b.x - a.x), dup, nocm: A.nocm.slice(0, 500)}, null, 1));
console.log("audit :", JSON.stringify({fixed: A.fixed.length, tp: A.tp.length, gap: A.gap.length, dup: dup.length, nocm: A.nocm.length}));
