// Raretés de toutes les extensions : pour chaque extension, sa date de sortie, son nombre de cartes
// et la liste des numéros par rareté. Sert aux cartes d'extensions (compteur par rareté, avancement).
// Sortie : rarities.json  { v, built, R:[noms de rareté], S:{ setId:{ d:date, t:total, o:officiel, a:abréviation, g:[[indexRareté,"num,num,…"],…] } } }
import fs from "node:fs";

const API = "https://api.tcgdex.net/v2";
const pocket = id => /^(P-A|[AB]\d+[a-z]?)$/.test(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function get(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, {signal: AbortSignal.timeout(60000), headers: {"cache-control": "no-cache", "user-agent": "cote-rarities"}});
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(1500 * (i + 1));
  }
  return null;
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({length: n}, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}
const setOf = id => id.slice(0, id.lastIndexOf("-"));

// 1. Raretés carte par carte, en français puis en anglais
async function rarityMap(lang) {
  const names = (await get(`${API}/${lang}/rarities`)) || [];
  const m = new Map();
  await pool(names, 4, async name => {
    const l = await get(`${API}/${lang}/cards?rarity=${encodeURIComponent("eq:" + name)}`);
    for (const c of l || []) if (c?.id && !m.has(c.id)) m.set(c.id, name);
  });
  console.log(lang, names.length, "raretés,", m.size, "cartes");
  return m;
}
const fr = await rarityMap("fr");
const en = await rarityMap("en");

// nom anglais → nom français, appris sur les cartes présentes dans les deux langues
const vote = new Map();
for (const [id, e] of en) { const f = fr.get(id); if (!f) continue; const v = vote.get(e) || new Map(); v.set(f, (v.get(f) || 0) + 1); vote.set(e, v); }
const en2fr = new Map([...vote].map(([e, v]) => [e, [...v].sort((a, b) => b[1] - a[1])[0][0]]));
const rarityOf = id => fr.get(id) || (en.has(id) ? (en2fr.get(en.get(id)) || en.get(id)) : null);

// 2. Extensions : date, nombre de cartes, liste des cartes
const S = {}, R = [], ri = n => { let i = R.indexOf(n); if (i < 0) { R.push(n); i = R.length - 1; } return i; };
for (const lang of ["fr", "en"]) {
  const sets = ((await get(`${API}/${lang}/sets`)) || []).filter(s => !pocket(s.id) && !S[s.id]);
  await pool(sets, 6, async b => {
    const s = await get(`${API}/${lang}/sets/${encodeURIComponent(b.id)}`);
    if (!s || S[b.id]) return;
    const cards = (s.cards || []).filter(c => c?.id);
    const g = new Map();
    for (const c of cards) {
      const r = rarityOf(c.id) || "Sans rareté";
      if (!g.has(r)) g.set(r, []);
      g.get(r).push(c.localId);
    }
    S[b.id] = {
      d: s.releaseDate || "", t: s.cardCount?.total || cards.length, o: s.cardCount?.official || 0,
      a: s.abbreviation?.official || "", n: s.name || "",
      g: [...g].map(([r, l]) => [ri(r), l.join(",")])
    };
  });
  console.log(lang, "extensions :", Object.keys(S).length);
}
if (Object.keys(S).length < 100) { console.error("Trop peu d'extensions, rien n'est publié"); process.exit(1); }
fs.writeFileSync("rarities.json", JSON.stringify({v: 1, built: new Date().toISOString(), R, S}));
console.log("rarities.json :", (fs.statSync("rarities.json").size / 1024).toFixed(0), "Ko,", R.length, "raretés :", R.join(" | "));
