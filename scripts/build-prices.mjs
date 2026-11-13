// Cotes de toutes les cartes, en un seul fichier : l'app affiche les prix d'une extension d'un coup,
// au lieu de demander la fiche de chaque carte une par une à TCGdex (jusqu'à 300 requêtes par extension).
// Relu 3 fois par jour par GitHub. Même calcul que l'app : fiche FR (sinon EN), variante principale,
// cote Cardmarket incohérente remplacée par le prix TCGplayer en € (extensions Écarlate et Violet / Méga-Évolution).
// Sortie : prices.json { v, built, n, p: { idExtension: { numéro: [cote, moy. 1 j, moy. 7 j, moy. 30 j] | 0 } } }
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
function fixPricing(d){
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
  const mi = d ? marketInfo(d) : null;
  (P[c.sid] ||= {})[c.n] = mi?.p ? (() => { const a = [r2(mi.p), r2(mi.a1), r2(mi.a7), r2(mi.a30)]; while (a.length > 1 && a[a.length - 1] == null) a.pop(); return a; })() : 0;
  if (mi?.p) priced++;
});
console.log("cartes cotées :", priced, "· échecs réseau :", failed);
if (priced < 5000) { console.error("Trop peu de cartes cotées, rien n'est publié"); process.exit(1); }
fs.writeFileSync("prices.json", JSON.stringify({v: 1, built: new Date().toISOString(), n: priced, p: P}));
console.log("prices.json :", (fs.statSync("prices.json").size / 1024).toFixed(0), "Ko");
