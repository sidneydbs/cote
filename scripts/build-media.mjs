// Construit media.json : la bonne image pour chaque extension (logo, symbole), chaque carte sans image TCGdex
// et chaque produit scellé sans photo. Vérifie réellement chaque adresse (code 200, vraie image, pas une image « absente »).
// Écrit aussi audit.json : ce qui reste sans image, pour le corriger.
import fs from "fs";
import crypto from "crypto";

const API = "https://api.tcgdex.net/v2";
const UA = {"user-agent": "DexScan/1.0 (+https://github.com/sidneydbs/cote)"};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
async function getJSON(u, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try { const r = await fetch(u, {headers: UA, signal: AbortSignal.timeout(30000)}); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) {}
    await sleep(1000 * (t + 1));
  }
  return null;
}
// images « absentes » renvoyées avec un code 200 (dos de carte, image grise) : on les reconnaît à leur empreinte
const BAD = new Set();
async function fingerprint(u) {
  try { const r = await fetch(u, {headers: UA, signal: AbortSignal.timeout(20000)}); if (!r.ok) return null; const b = Buffer.from(await r.arrayBuffer()); return crypto.createHash("md5").update(b).digest("hex"); } catch (e) { return null; }
}
const memo = new Map();
async function okImg(u) {
  if (!u) return false;
  if (memo.has(u)) return memo.get(u);
  let ok = false;
  for (let t = 0; t < 2 && !ok; t++) {
    try {
      const r = await fetch(u, {headers: UA, signal: AbortSignal.timeout(20000)});
      if (r.ok && /image/.test(r.headers.get("content-type") || "")) {
        const b = Buffer.from(await r.arrayBuffer());
        ok = b.length > 300 && !BAD.has(crypto.createHash("md5").update(b).digest("hex"));
      }
      if (r.status === 404 || r.status === 400 || r.status === 403) break;
    } catch (e) { await sleep(500); }
  }
  memo.set(u, ok); return ok;
}
async function firstOk(list) { for (const u of list) if (await okImg(u)) return u; return null; }
async function pool(items, n, fn) { let i = 0; const out = new Array(items.length); await Promise.all(Array.from({length: n}, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); } })); return out; }

// sources de secours déjà connues de l'app (même table que dans index.html)
const html = fs.readFileSync("index.html", "utf8");
const SRC = JSON.parse(html.match(/const SRC = (\{.*?\});\n/)[1]);
const srcUrl = u => u.replace(/^@t\//, "https://assets.tcgdex.net/").replace(/^@p\//, "https://images.pokemontcg.io/");
const sxNum = l => { const m = String(l).match(/^([A-Za-z]*)0*(\d+)([a-z]?)$/); return m ? m[1] + m[2] + m[3] : l; };

for (const u of ["https://images.pokemontcg.io/base1/99999.png", "https://images.pokemontcg.io/base1/99999_hires.png", "https://images.scrydex.com/pokemon/zz9-99999/small", "https://images.scrydex.com/pokemon/zz9-99999/large"]) { const h = await fingerprint(u); if (h) BAD.add(h); }
console.log(`${BAD.size} images « absentes » connues`);

const [frSets, enSets] = await Promise.all([getJSON(`${API}/fr/sets`), getJSON(`${API}/en/sets`)]);
if (!frSets?.length || !enSets?.length) { console.error("TCGdex indisponible"); process.exit(1); }
const ids = [...new Set([...frSets.map(s => s.id), ...enSets.map(s => s.id), ...Object.keys(SRC.pt), ...Object.keys(SRC.logo), ...Object.keys(SRC.sx || {})])];
const fr = new Map(frSets.map(s => [s.id, s])), en = new Map(enSets.map(s => [s.id, s]));
console.log(`${ids.length} extensions`);

const media = {v: 1, built: new Date().toISOString(), sets: {}, cards: {}, sealed: {}};
const audit = {built: media.built, sets: {total: ids.length, noLogo: [], noSymbol: []}, cards: {total: 0, tcgdex: 0, fallback: 0, missing: []}, sealed: {total: 0, photo: 0, logo: 0, missing: 0}};

// 1. logos et symboles
await pool(ids, 12, async id => {
  const f = fr.get(id), e = en.get(id), sx = SRC.sx?.[id], sxc = sx ? (typeof sx === "string" ? sx : sx.c) : null;
  const logos = [f?.logo && f.logo + ".webp", f?.logo && f.logo + ".png", e?.logo && e.logo + ".webp", e?.logo && e.logo + ".png",
    SRC.logo[id] && srcUrl(SRC.logo[id]), SRC.pt[id] && `https://images.pokemontcg.io/${SRC.pt[id]}/logo.png`, sxc && `https://images.scrydex.com/pokemon/${sxc}-logo/logo`].filter(Boolean);
  const syms = [f?.symbol && f.symbol + ".webp", f?.symbol && f.symbol + ".png", e?.symbol && e.symbol + ".webp", e?.symbol && e.symbol + ".png",
    SRC.pt[id] && `https://images.pokemontcg.io/${SRC.pt[id]}/symbol.png`, sxc && `https://images.scrydex.com/pokemon/${sxc}-symbol/symbol`].filter(Boolean);
  const l = await firstOk(logos), s = await firstOk(syms);
  media.sets[id] = {l, s};
  if (!l) audit.sets.noLogo.push(id); if (!s) audit.sets.noSymbol.push(id);
});
console.log(`logos : ${ids.length - audit.sets.noLogo.length}/${ids.length} · symboles : ${ids.length - audit.sets.noSymbol.length}/${ids.length}`);

// 2. cartes sans image TCGdex (ni en français, ni en anglais) : on cherche chez Limitless, Scrydex, pokemontcg.io
const llUrl = (set, loc) => { const e = SRC.ll[set]; if (!e) return null; const c = typeof e === "string" ? e : e.c; let k = (typeof e === "object" && e.m && e.m[loc]) || loc; if (/^\d+$/.test(k)) k = String(k).padStart(3, "0"); return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${c}/${c}_${k}_R_EN_SM.png`; };
const cardSets = [...new Set([...frSets.map(s => s.id), ...enSets.map(s => s.id)])];
await pool(cardSets, 8, async sid => {
  const [a, b] = await Promise.all([fr.has(sid) ? getJSON(`${API}/fr/sets/${encodeURIComponent(sid)}`) : null, en.has(sid) ? getJSON(`${API}/en/sets/${encodeURIComponent(sid)}`) : null]);
  const cards = new Map();
  for (const c of [...(a?.cards || []), ...(b?.cards || [])]) { const x = cards.get(c.id) || {id: c.id, localId: c.localId, img: false}; if (c.image) x.img = true; cards.set(c.id, x); }
  for (const c of cards.values()) {
    audit.cards.total++;
    if (c.img) { audit.cards.tcgdex++; continue; }
    const sx = SRC.sx?.[sid], cands = [];
    if (SRC.ll[sid]) cands.push(["ll", llUrl(sid, c.localId)]);
    if (sx) { const k = (typeof sx === "object" && sx.m?.[c.localId]) || sxNum(c.localId); cands.push(["sx", `https://images.scrydex.com/pokemon/${typeof sx === "string" ? sx : sx.c}-${k}/small`]); }
    if (SRC.pt[sid]) cands.push(["pt", `https://images.pokemontcg.io/${SRC.pt[sid]}/${c.localId}.png`]);
    let got = null; for (const [k, u] of cands) if (await okImg(u)) { got = k; break; }
    if (got) { media.cards[c.id] = got; audit.cards.fallback++; } else audit.cards.missing.push(c.id);
  }
});
console.log(`cartes : ${audit.cards.total} · TCGdex ${audit.cards.tcgdex} · secours ${audit.cards.fallback} · sans image ${audit.cards.missing.length}`);

// 3. scellés Cardmarket sans photo : logo de leur extension (trouvée par le nom), sinon rien
const cm = readJSON("cm-sealed.json", {items: []});
const setNames = [...enSets].filter(s => s.name && s.name.length > 4).map(s => [s.name.toLowerCase(), s.id]).sort((x, y) => y[0].length - x[0].length);
for (const x of cm.items) {
  audit.sealed.total++;
  if (x.img) { audit.sealed.photo++; continue; }
  const n = x.n.toLowerCase(), hit = setNames.find(([nm]) => n.includes(nm));
  const l = hit && media.sets[hit[1]]?.l;
  if (l) { media.sealed[x.i] = l; audit.sealed.logo++; } else audit.sealed.missing++;
}
console.log(`scellés : ${audit.sealed.total} · photo ${audit.sealed.photo} · logo d'extension ${audit.sealed.logo} · rien ${audit.sealed.missing}`);

audit.cards.missing = audit.cards.missing.slice(0, 2000);
fs.writeFileSync("media.json", JSON.stringify(media));
fs.writeFileSync("audit.json", JSON.stringify(audit, null, 1));
console.log("media.json et audit.json écrits");
