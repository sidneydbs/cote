// Construit media.json : la bonne image pour chaque extension (logo, symbole), chaque carte sans image TCGdex
// et chaque produit scellé sans photo. Vérifie réellement chaque adresse (code 200, vraie image, pas une image « absente »).
// Les logos et symboles trouvés sont copiés dans le dépôt (dossier media/) : ils s'affichent même si la source tombe.
// Écrit aussi audit.json : ce qui reste sans image, et les erreurs rencontrées par source.
import fs from "fs";
import crypto from "crypto";
import {execSync} from "child_process";

const API = "https://api.tcgdex.net/v2";
const UA = {"user-agent": "Mozilla/5.0 (compatible; DexScan/1.0; +https://github.com/sidneydbs/cote)", "accept": "image/avif,image/webp,image/png,image/*,*/*;q=0.8"};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
const md5 = b => crypto.createHash("md5").update(b).digest("hex");
async function getJSON(u, tries = 3, headers = {}) {
  for (let t = 0; t < tries; t++) {
    try { const r = await fetch(u, {headers: {...UA, accept: "application/json", ...headers}, signal: AbortSignal.timeout(40000)}); if (r.ok) return await r.json(); if (r.status === 404) return null; } catch (e) {}
    await sleep(1500 * (t + 1));
  }
  return null;
}
const diag = {};
const note = (u, k) => { const h = new URL(u).host; diag[h] = diag[h] || {}; diag[h][k] = (diag[h][k] || 0) + 1; };
// télécharge une image ; null si absente, en erreur ou image « absente » connue
const BAD = new Set();
const memo = new Map();
async function getImg(u) {
  if (!u) return null;
  if (memo.has(u)) return memo.get(u);
  let out = null;
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(u, {headers: UA, redirect: "follow", signal: AbortSignal.timeout(25000)});
      if (r.ok) {
        const ct = r.headers.get("content-type") || "", b = Buffer.from(await r.arrayBuffer());
        if (!/image/.test(ct)) { note(u, "pas-image"); break; }
        if (b.length < 300) { note(u, "trop-petit"); break; }
        if (BAD.has(md5(b))) { note(u, "absente"); break; }
        note(u, "ok"); out = {b, ct}; break;
      }
      note(u, String(r.status));
      if ([400, 401, 403, 404, 410].includes(r.status)) break;
    } catch (e) { note(u, "réseau"); }
    await sleep(800 * (t + 1));
  }
  memo.set(u, out); return out;
}
const okImg = async u => !!(await getImg(u));
async function firstOk(list) { for (const u of list) { const x = await getImg(u); if (x) return {u, ...x}; } return null; }
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({length: n}, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

// sources de secours déjà connues de l'app (même table que dans index.html)
const html = fs.readFileSync("index.html", "utf8");
const SRC = JSON.parse(html.match(/const SRC = (\{.*?\});\n/)[1]);
const srcUrl = u => u.replace(/^@t\//, "https://assets.tcgdex.net/").replace(/^@p\//, "https://images.pokemontcg.io/");
const sxNum = l => { const m = String(l).match(/^([A-Za-z]*)0*(\d+)([a-z]?)$/); return m ? m[1] + m[2] + m[3] : l; };
const isPocket = id => /^(P-A|[AB]\d+[a-z]?)$/.test(id);
const SX = "https://images.scrydex.com/pokemon";

// empreintes des images « absentes » (dos de carte pokemontcg, images grises scrydex)
for (const u of ["https://images.pokemontcg.io/base1/99999.png", "https://images.pokemontcg.io/base1/99999_hires.png", "https://images.pokemontcg.io/zz9/logo.png", "https://images.pokemontcg.io/zz9/symbol.png",
  `${SX}/zz9-99999/small`, `${SX}/zz9-99999/large`, `${SX}/zz9-1/small`, `${SX}/zz9-logo/logo`, `${SX}/zz9-symbol/symbol`, `${SX}/zz8-logo/logo`]) {
  try { const r = await fetch(u, {headers: UA, signal: AbortSignal.timeout(20000)}); if (r.ok) BAD.add(md5(Buffer.from(await r.arrayBuffer()))); } catch (e) {}
}
console.log(`${BAD.size} images « absentes » connues`);

const [frSets, enSets] = await Promise.all([getJSON(`${API}/fr/sets`), getJSON(`${API}/en/sets`)]);
if (!frSets?.length || !enSets?.length) { console.error("TCGdex indisponible"); process.exit(1); }
const fr = new Map(frSets.map(s => [s.id, s])), en = new Map(enSets.map(s => [s.id, s]));
const ids = [...new Set([...frSets.map(s => s.id), ...enSets.map(s => s.id), ...Object.keys(SRC.pt), ...Object.keys(SRC.logo), ...Object.keys(SRC.sx || {})])].filter(id => !isPocket(id));
console.log(`${ids.length} extensions (hors TCG Pocket)`);

// codes scrydex possibles d'une extension : table de l'app, code du logo scrydex, code pokemontcg, id TCGdex (« 5.5 » → « 5pt5 »)
const sxCodes = id => {
  const out = [], sx = SRC.sx?.[id];
  if (sx) out.push(typeof sx === "string" ? sx : sx.c);
  const lg = SRC.logo[id]?.match(/scrydex\.com\/pokemon\/([^/]+)-logo\//); if (lg) out.push(lg[1]);
  if (SRC.pt[id]) out.push(SRC.pt[id]);
  out.push(id.replace(/\./g, "pt"));
  return [...new Set(out)];
};

// kits du dresseur : TCGdex (tk-xy-n…) et pokemontcg/scrydex (tk6b…) n'ont pas les mêmes codes → on les apparie par les noms des cartes
const TK = {};
{
  const tkIds = ids.filter(id => id.startsWith("tk-"));
  const codes = []; for (let n = 1; n <= 12; n++) codes.push(`tk${n}a`, `tk${n}b`);
  const pt = {};
  await pool(codes, 4, async c => { const j = await getJSON(`https://api.pokemontcg.io/v2/cards?q=set.id:${c}&select=number,name&pageSize=250`, 2); if (j?.data?.length) pt[c] = new Map(j.data.map(x => [String(x.number), x.name.toLowerCase()])); });
  await pool(tkIds, 4, async id => {
    const s = await getJSON(`${API}/en/sets/${encodeURIComponent(id)}`); if (!s?.cards?.length) return;
    let best = null;
    for (const [c, m] of Object.entries(pt)) {
      let hit = 0; for (const x of s.cards) if (m.get(String(Number(x.localId) || x.localId)) === x.name.toLowerCase()) hit++;
      const sc = hit / s.cards.length; if (sc >= 0.5 && (!best || sc > best[1])) best = [c, sc];
    }
    if (best) TK[id] = best[0];
  });
  console.log(`kits du dresseur appariés : ${Object.keys(TK).length}/${tkIds.length}`, JSON.stringify(TK));
}

const media = {v: 2, built: new Date().toISOString(), sets: {}, cards: {}, sealed: {}};
const audit = {built: media.built, sets: {total: ids.length, noLogo: [], noSymbol: []}, cards: {total: 0, tcgdex: 0, fallback: 0, missing: [], bySet: {}}, sealed: {total: 0, photo: 0, logo: 0, missing: 0}, tk: TK, diag};

// 1. logos et symboles, copiés dans media/
fs.mkdirSync("media/sets", {recursive: true});
const ext = ct => /png/.test(ct) ? "png" : /webp/.test(ct) ? "webp" : /svg/.test(ct) ? "svg" : /gif/.test(ct) ? "gif" : "jpg";
const keep = new Set();
function save(id, k, x) {
  const f = `media/sets/${id.replace(/[^\w.-]/g, "_")}-${k}.${ext(x.ct)}`;
  const old = fs.existsSync(f) ? fs.readFileSync(f) : null;
  if (!old || !old.equals(x.b)) fs.writeFileSync(f, x.b);
  keep.add(f); return f;
}
await pool(ids, 4, async id => {
  const f = fr.get(id), e = en.get(id), codes = [...sxCodes(id), ...(TK[id] ? [TK[id]] : [])];
  const tc = (o, k) => o?.[k] ? [o[k] + ".png", o[k] + ".webp"] : [];
  const logos = [...tc(f, "logo"), ...tc(e, "logo"), SRC.logo[id] && srcUrl(SRC.logo[id]),
    SRC.pt[id] && `https://images.pokemontcg.io/${SRC.pt[id]}/logo.png`, TK[id] && `https://images.pokemontcg.io/${TK[id]}/logo.png`, ...codes.map(c => `${SX}/${c}-logo/logo`)].filter(Boolean);
  const syms = [...tc(f, "symbol"), ...tc(e, "symbol"),
    SRC.pt[id] && `https://images.pokemontcg.io/${SRC.pt[id]}/symbol.png`, TK[id] && `https://images.pokemontcg.io/${TK[id]}/symbol.png`, ...codes.map(c => `${SX}/${c}-symbol/symbol`)].filter(Boolean);
  const l = await firstOk(logos), s = await firstOk(syms);
  media.sets[id] = {l: l ? save(id, "l", l) : null, s: s ? save(id, "s", s) : null, lu: l?.u || null, su: s?.u || null};
  if (!l) audit.sets.noLogo.push(id); if (!s) audit.sets.noSymbol.push(id);
});
for (const f of fs.readdirSync("media/sets")) if (!keep.has(`media/sets/${f}`)) fs.unlinkSync(`media/sets/${f}`);   // extensions disparues
console.log(`logos : ${ids.length - audit.sets.noLogo.length}/${ids.length} · symboles : ${ids.length - audit.sets.noSymbol.length}/${ids.length}`);

// 2. cartes sans image TCGdex (ni en français, ni en anglais) : Limitless, Scrydex, pokemontcg.io
const llUrl = (set, loc) => { const e = SRC.ll[set]; if (!e) return null; const c = typeof e === "string" ? e : e.c; let k = (typeof e === "object" && e.m && e.m[loc]) || loc; if (/^\d+$/.test(k)) k = String(k).padStart(3, "0"); return `https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/${c}/${c}_${k}_R_EN_SM.png`; };
const cardSets = [...new Set([...frSets.map(s => s.id), ...enSets.map(s => s.id)])].filter(id => !isPocket(id));
await pool(cardSets, 6, async sid => {
  const [a, b] = await Promise.all([fr.has(sid) ? getJSON(`${API}/fr/sets/${encodeURIComponent(sid)}`) : null, en.has(sid) ? getJSON(`${API}/en/sets/${encodeURIComponent(sid)}`) : null]);
  const cards = new Map();
  for (const c of [...(a?.cards || []), ...(b?.cards || [])]) { const x = cards.get(c.id) || {id: c.id, localId: c.localId, img: false}; if (c.image) x.img = true; cards.set(c.id, x); }
  const codes = [...sxCodes(sid), ...(TK[sid] ? [TK[sid]] : [])], sxm = typeof SRC.sx?.[sid] === "object" ? SRC.sx[sid].m : null;
  const ptc = SRC.pt[sid] || TK[sid];
  const dead = new Set();   // une source qui échoue sur 6 cartes d affilée n'est plus essayée pour cette extension
  const fails = {};
  for (const c of cards.values()) {
    audit.cards.total++;
    if (c.img) { audit.cards.tcgdex++; continue; }
    const cands = [];
    if (SRC.ll[sid]) cands.push(["ll", llUrl(sid, c.localId)]);
    codes.forEach((code, i) => cands.push([`sx${i}`, `${SX}/${code}-${(i === 0 && sxm?.[c.localId]) || sxNum(c.localId)}/small`]));
    if (ptc) cands.push(["pt", `https://images.pokemontcg.io/${ptc}/${sxNum(c.localId)}.png`]);
    let got = null;
    for (const [k, u] of cands) {
      if (dead.has(k)) continue;
      if (await okImg(u)) { got = [k, u]; fails[k] = 0; break; }
      fails[k] = (fails[k] || 0) + 1; if (fails[k] >= 6) dead.add(k);
    }
    if (got) {
      // « ll », « sx », « pt » : l'app sait déjà construire l'adresse ; sinon on donne l'adresse complète
      const k = got[0], u = got[1];
      media.cards[c.id] = k === "ll" ? "ll" : k === "pt" && ptc === SRC.pt[sid] ? "pt" : k === "sx0" && SRC.sx?.[sid] ? "sx" : u;
      audit.cards.fallback++;
    } else { audit.cards.missing.push(c.id); audit.cards.bySet[sid] = (audit.cards.bySet[sid] || 0) + 1; }
  }
});
console.log(`cartes : ${audit.cards.total} · TCGdex ${audit.cards.tcgdex} · secours ${audit.cards.fallback} · sans image ${audit.cards.missing.length}`);

// 3. scellés Cardmarket sans photo : logo de leur extension, trouvée par le nom du produit
//    ou par les autres produits de la même extension Cardmarket
const cm = readJSON("cm-sealed.json", {items: []});
const nameKey = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const setNames = enSets.filter(s => s.name && s.name.length > 3 && !isPocket(s.id) && media.sets[s.id]?.l).map(s => [" " + nameKey(s.name) + " ", s.id]).sort((x, y) => y[0].length - x[0].length);
const byExp = {};
const findSet = n => { const k = " " + nameKey(n) + " "; return setNames.find(([nm]) => k.includes(nm))?.[1]; };
for (const x of cm.items) { const s = findSet(x.n); if (s && x.e != null) { byExp[x.e] = byExp[x.e] || {}; byExp[x.e][s] = (byExp[x.e][s] || 0) + 1; } }
for (const x of cm.items) {
  audit.sealed.total++;
  if (x.img) { audit.sealed.photo++; continue; }
  let s = findSet(x.n);
  if (!s && byExp[x.e]) s = Object.entries(byExp[x.e]).sort((a, b) => b[1] - a[1])[0][0];
  const l = s && media.sets[s]?.l;
  if (l) { media.sealed[x.i] = l; audit.sealed.logo++; } else audit.sealed.missing++;
}
console.log(`scellés : ${audit.sealed.total} · photo ${audit.sealed.photo} · logo d'extension ${audit.sealed.logo} · rien ${audit.sealed.missing}`);
console.log("sources :", JSON.stringify(diag));

audit.cards.missing = audit.cards.missing.slice(0, 3000);
fs.writeFileSync("media.json", JSON.stringify(media));
fs.writeFileSync("audit.json", JSON.stringify(audit, null, 1));
// les images copiées sont ajoutées au commit de la tâche (qui publie media.json et audit.json)
try { execSync("git add -A media", {stdio: "inherit"}); } catch (e) {}
console.log("media.json et audit.json écrits");
