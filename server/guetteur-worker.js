/* Guetteur Dex Scan — version en ligne (Cloudflare Worker + D1), réunit les deux guetteurs du PC :
   - « guetteur » (Node) : boutiques, flux RSS, pages de recherche, fiches produit
   - « Guetteur Pokemon » (PowerShell) : fiches produit précises + rappel toutes les 10 min tant que c'est dispo
   Toutes les minutes (déclencheur cron), chaque source dont c'est l'heure est relue dans sa propre exécution.
   Liaisons du Worker : DB (base D1), SELF (le Worker lui-même), NTFY_TOPIC (canal ntfy, gardé secret).
   Réglages : guetteur-config.txt (même format que config.json du PC, sans le canal ntfy). */
import RAW from "./guetteur-config.txt";
const BASE = JSON.parse(RAW);
let CFG, POKE, HOT, STOCK, NOPE, TCG_RE, FORT, SOURCES, CFGV = null;
// réglages : ceux enregistrés depuis /reglages (base D1, ligne « cfg ») remplacent ceux du fichier
function setup(cfg){
  CFG = cfg; POKE = new RegExp(CFG.motsPokemon, "i"); HOT = new RegExp(CFG.motsUrgents, "i"); STOCK = new RegExp(CFG.motsStock, "i"); NOPE = new RegExp(CFG.motsExclus, "i");
  TCG_RE = CFG.tcg ? new RegExp(`(^|[^a-z0-9])(${[...CFG.tcg.produits, ...CFG.tcg.extensions].map(motRe).join("|")})(?=$|[^a-z0-9])` + (CFG.tcg.codes ? `|${CFG.tcg.codes}` : ""), "i") : /./;
  FORT = new RegExp(CFG.motsTCGforts || "(?!)", "i"); SOURCES = CFG.sources.filter(s => s.actif !== false);
}
async function loadCfg(env){
  const r = await env.DB.prepare("SELECT v,t FROM st WHERE k='cfg'").first();
  const v = r ? r.t : 0; if (v === CFGV && CFG) return;
  setup(r ? JSON.parse(r.v) : BASE); CFGV = v;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 DexScanGuetteur/1.0";
const sansAcc = x => String(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const motRe = w => sansAcc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s\-–'’&]+/g, "[\\s\\-–'’&]*");
const TCG = t => TCG_RE.test(sansAcc(t));
const exclu = t => NOPE.test(t) && !(FORT.test(t) && !/peluche|carte cadeau|jeu vid[ée]o|switch|sleeves?|blind ?box/i.test(t));
const decode = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const MAX_SEEN = 1500, MAX_BODY = 700000;
const httpErr = (st, m) => Object.assign(new Error(m || "HTTP " + st), {status: st});
const prixTxt = p => p ? ` — ${(+p).toFixed(2).replace(".", ",")} €` : "";
const heure = () => new Date().toLocaleTimeString("fr-FR", {timeZone: "Europe/Paris"});

// ---------- état (D1 : une ligne par source) ----------
async function getSt(env, k){ const r = await env.DB.prepare("SELECT v FROM st WHERE k=?").bind(k).first(); return r ? JSON.parse(r.v) : null; }
async function putSt(env, k, v){ await env.DB.prepare("INSERT INTO st(k,v,t) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, t=excluded.t").bind(k, JSON.stringify(v), Date.now()).run(); }
async function logAl(env, line){ await env.DB.prepare("INSERT INTO log(t,l) VALUES(?,?)").bind(Date.now(), line.slice(0, 600)).run(); }

// ---------- notification iPhone (ntfy) ----------
async function notify(env, {title, message, url, priority = 4, tags = [], pub = false}){
  await logAl(env, `🔔 ${title} — ${message} ${url || ""}`);
  // alertes publiques : gardées pour l'onglet Alertes de l'app + notification à chaque téléphone abonné
  if (pub){ try { await pubAlert(env, {title, message, url, priority}); } catch (e) { await logAl(env, "⚠️ notifications : " + e.message); } }
  if (!env.NTFY_TOPIC) return;
  for (let t = 0; t < 2; t++){
    try {
      const r = await fetch("https://ntfy.sh", {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({topic: env.NTFY_TOPIC, title: title.slice(0, 250), message: message.slice(0, 900), priority, tags, click: url || undefined,
          actions: url ? [{action: "view", label: "Ouvrir", url}] : undefined})});
      if (r.ok) return;
    } catch (e) {}
  }
}

// ---------- lecture ----------
async function get(src, st){
  const h = {"user-agent": UA, "accept-language": "fr-FR,fr;q=0.9", "accept": "text/html,application/xhtml+xml,application/xml,application/json;q=0.9,*/*;q=0.8"};
  if (st.etag) h["if-none-match"] = st.etag; if (st.lm) h["if-modified-since"] = st.lm;
  const r = await fetch(src.url, {headers: h, redirect: "follow", cf: {cacheTtl: 0}});
  if (r.status === 304) return {notModified: true};
  if (!r.ok) throw httpErr(r.status);
  let body = await r.text(); if (body.length > MAX_BODY) body = body.slice(0, MAX_BODY);
  if (/captcha|datadome|cf-chl|challenge-platform|Access Denied|Request unsuccessful|px-captcha/i.test(body.slice(0, 20000)) && body.length < 60000) throw httpErr(403, "protection anti-robot");
  st.etag = r.headers.get("etag") || undefined; st.lm = r.headers.get("last-modified") || undefined;
  return {body};
}
function parse(src, body){
  if (src.type === "rss"){
    return [...body.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]).map(it => {
      const title = decode((it.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
      const link = decode((it.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]) || ((it.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "");
      const desc = decode((it.match(/<(description|summary|content)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2]).slice(0, 400);
      const id = decode((it.match(/<(guid|id)[^>]*>([\s\S]*?)<\/\1>/i) || [])[2]) || link || title;
      // Dealabs : le marchand et le prix, pour savoir où acheter même si le deal est retiré ensuite
      const shop = decode((it.match(/<pepper:merchant[^>]*name="([^"]+)"/i) || [])[1]), price = decode((it.match(/<pepper:merchant[^>]*price="([^"]+)"/i) || it.match(/<pepper:price[^>]*>([\s\S]*?)<\/pepper:price>/i) || [])[1]);
      const more = [shop && "chez " + shop, /\d/.test(price) ? price.replace(/\s*€\s*$/, "").trim() + " €" : ""].filter(Boolean).join(", ");
      return {id, title: more ? `${title} (${more})` : title, url: link, text: title + " " + desc};
    });
  }
  if (src.type === "shopify"){
    const j = JSON.parse(body), base = new URL(src.url).origin;
    return (j.products || []).map(p => { const avail = (p.variants || []).some(v => v.available);
      return {id: p.id + (avail ? ":dispo" : ":rupture"), title: p.title, url: `${base}/products/${p.handle}`, text: `${p.title} ${(p.tags || []).join(" ")} ${avail ? "disponible" : ""}`, avail};
    }).filter(x => src.dispoSeulement ? x.avail : true);
  }
  const base = src.url, out = new Map();
  for (const m of body.matchAll(/<a\b[^>]*href="([^"#]+)"[^>]*>([\s\S]{0,1500}?)<\/a>/gi)){
    const title = decode(m[2]).slice(0, 200); if (title.length < 8 || !POKE.test(title)) continue;
    let url; try { url = new URL(decode(m[1]), base).href; } catch (e) { continue; }
    if (!out.has(url)) out.set(url, {id: url, title, url, text: title});
  }
  for (const m of body.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)){
    try { const walk = o => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) return o.forEach(walk);
        if (o.name && (o.url || o["@id"]) && /Product|ListItem/i.test(String(o["@type"]))){ let u; try { u = new URL(o.url || o["@id"], base).href; } catch (e) {}
          if (u && !out.has(u)) out.set(u, {id: u, title: String(o.name).slice(0, 200), url: u, text: String(o.name) + " " + JSON.stringify(o.offers || "").slice(0, 300)}); }
        Object.values(o).forEach(walk); };
      walk(JSON.parse(m[1])); } catch (e) {}
  }
  if (HOT.test(body)) for (const x of out.values()){ const i = body.indexOf(x.url.replace(new URL(base).origin, "")); if (i > 0 && HOT.test(body.slice(Math.max(0, i - 600), i + 900))) x.text += " précommande"; }
  return [...out.values()];
}

// ---------- types de source ----------
async function runFlux(env, src, st){                       // rss, shopify, page : alerte sur chaque NOUVEL élément
  const r = await get(src, st); if (r.notModified) return "inchangé";
  const items = parse(src, r.body), seen = new Set(st.seen || []), first = !st.init;
  let n = 0;
  for (const x of items){
    if (seen.has(x.id)) continue; seen.add(x.id);
    if (first && !CFG.alerterAuDemarrage) continue;
    const t = `${x.title} ${x.text}`;
    if (exclu(t) || !(src.toutPokemon || POKE.test(t)) || !TCG(t)) continue;
    if (src.motsCles && !new RegExp(src.motsCles, "i").test(t)) continue;
    const hot = HOT.test(t), stock = STOCK.test(t) || x.avail;
    if (!src.toutAlerter && !hot && !stock && src.type !== "shopify" && src.type !== "page") continue;
    const kind = /invitation|invit|tirage au sort|loterie|lottery|raffle/i.test(t) ? "INVITATION" : hot ? "PRÉCOMMANDE" : stock ? "DISPO" : "NOUVEAU";
    await notify(env, {pub: true, title: `${kind} · ${src.nom}`, message: x.title, url: x.url, priority: kind === "INVITATION" || kind === "PRÉCOMMANDE" ? 5 : 4,
      tags: [kind === "INVITATION" ? "envelope" : kind === "PRÉCOMMANDE" ? "rotating_light" : "package"]}); n++;
  }
  st.seen = [...seen].slice(-MAX_SEEN); st.init = true;
  return `${items.length} éléments${n ? `, ${n} alerte${n > 1 ? "s" : ""}` : ""}`;
}
async function catalogue(src){
  const out = [], u = new URL(src.url), woo = src.plateforme === "woocommerce";
  for (let page = 1; page <= (src.pagesMax || 6); page++){
    if (woo){ u.searchParams.set("per_page", "100"); } else u.searchParams.set("limit", "250");
    u.searchParams.set("page", String(page));
    const r = await fetch(u.href, {headers: {"user-agent": UA, "accept": "application/json", "accept-language": "fr-FR,fr;q=0.9"}});
    if (woo && r.status === 400 && page > 1) break;
    if (!r.ok) throw httpErr(r.status);
    const j = await r.json(), ps = woo ? j.map(p => ({id: "w" + p.id, title: decode(p.name), url: p.permalink, tags: (p.categories || []).map(c => c.name),
      variants: [{available: !!(p.is_in_stock && p.is_purchasable), price: p.prices ? String(+p.prices.price / 10 ** (p.prices.currency_minor_unit ?? 2)) : null}]})) : (j.products || []);
    out.push(...ps); if (ps.length < (woo ? 100 : 250)) break;
  }
  return out;
}
async function runBoutique(env, src, st){                   // boutique entière : nouveau produit + chaque retour en stock
  const origin = new URL(src.url).origin, first = !st.init, etat = st.etat || {};
  let ps = await catalogue(src), dispo = 0, n = 0;
  if (src.filtrePokemon) ps = ps.filter(p => POKE.test(`${p.title} ${(p.tags || []).join(" ")} ${p.product_type || ""}`));
  const vus = new Set(ps.map(p => String(p.id)));
  for (const k of Object.keys(etat)) if (!vus.has(k) && etat[k] === "d") etat[k] = "r";
  for (const p of ps){
    const avail = (p.variants || []).some(v => v.available); if (avail) dispo++;
    const k = String(p.id), prev = etat[k], cur = avail ? "d" : "r";
    if (prev === cur) continue; etat[k] = cur;
    if (first) continue;
    const t = `${p.title} ${(p.tags || []).join(" ")}`;
    if ((!src.sansExclusions && exclu(t)) || !TCG(t)) continue;
    const prices = (p.variants || []).map(v => +v.price).filter(x => x > 0), price = prices.length ? Math.min(...prices) : null;
    const url = p.url || `${origin}/products/${p.handle}`;
    if (prev === undefined){
      const kind = /invitation|tirage au sort|loterie/i.test(t) ? "INVITATION" : HOT.test(t) ? "PRÉCOMMANDE" : "NOUVEAU";
      await notify(env, {pub: true, title: `${kind} · ${src.nom}`, message: `${p.title}${prixTxt(price)}${avail ? "" : " (pas encore en stock)"}`, url, priority: kind === "NOUVEAU" && !avail ? 4 : 5, tags: [kind === "NOUVEAU" ? "new" : "rotating_light"]}); n++;
    } else if (avail){ await notify(env, {pub: true, title: `DISPO · ${src.nom}`, message: `De retour en stock : ${p.title}${prixTxt(price)}`, url, priority: 5, tags: ["rotating_light"]}); n++; }
  }
  st.etat = etat; st.init = true;
  return `${dispo}/${ps.length} en stock${n ? `, ${n} alerte${n > 1 ? "s" : ""}` : ""}`;
}
async function lireProduit(src, st){
  const u = new URL(src.url), m = u.pathname.match(/\/products\/([^/?#]+)/);
  if (m){
    const r = await fetch(`${u.origin}/products/${m[1]}.js`, {headers: {"user-agent": UA, "accept-language": "fr-FR,fr;q=0.9"}});
    if (r.ok){ const p = await r.json(); return {title: p.title, avail: !!p.available, price: p.price != null ? p.price / 100 : null}; }
    if (r.status === 403 || r.status === 429) throw httpErr(r.status);
  }
  const {body} = await get(src, {});
  let title = decode((body.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]), avail = null, price = null;
  for (const s of body.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)){
    try { const walk = o => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) return o.forEach(walk);
      if (/Product/i.test(String(o["@type"])) && o.name) title = String(o.name);
      if (o.availability){ avail = avail || /InStock|PreOrder|LimitedAvailability|OnlineOnly/i.test(o.availability); if (o.price != null) price = +o.price; }
      Object.values(o).forEach(walk); }; walk(JSON.parse(s[1])); } catch (e) {}
  }
  if (avail === null){ const l = body.toLowerCase();
    avail = !/rupture|[ée]puis[ée]|indisponible|sold ?out|out of stock|prix [àa] venir|nous vous informerons quand|me pr[ée]venir|m'alerter|bient[ôo]t disponible/.test(l) && /ajouter au panier|add to cart|pr[ée]commander\b|acheter maintenant/.test(l); }
  return {title, avail, price};
}
async function runProduit(env, src, st){                    // fiche produit précise : alerte au retour en stock + rappel tant que c'est dispo
  const p = await lireProduit(src, st), now = Date.now(), rappel = (src.rappelMin ?? CFG.rappelMin ?? 10) * 60e3;
  if (p.avail && (st.dispo !== true || (rappel && now - (st.alerte || 0) >= rappel))){
    const kind = HOT.test(p.title) ? "PRÉCOMMANDE" : "DISPO";
    await notify(env, {pub: st.dispo !== true, title: `${kind} · ${src.nom}`, message: `${st.dispo === true ? "Toujours en stock" : "EN STOCK"} : ${p.title}${prixTxt(p.price)}`, url: src.url, priority: 5, tags: ["rotating_light"]});
    st.alerte = now;
  }
  st.dispo = !!p.avail;
  return p.avail ? "EN STOCK" : "rupture";
}

// ---------- une source = une exécution ----------
async function runSource(env, nom){
  const src = CFG.sources.find(s => s.nom === nom); if (!src) return "source inconnue";
  const k = "s:" + src.nom, st = (await getSt(env, k)) || {}, now = Date.now();
  if (now < (st.pause || 0)) return "en pause";
  try {
    const res = src.type === "produit" ? await runProduit(env, src, st) : src.type === "boutique" ? await runBoutique(env, src, st) : await runFlux(env, src, st);
    st.fails = 0; st.ok = (st.ok || 0) + 1; st.last = `${res} · ${heure()}`;
  } catch (e) {
    st.fails = (st.fails || 0) + 1; st.err = (st.err || 0) + 1; st.last = `${e.message} · ${heure()}`;
    if (e.status === 403 || e.status === 429 || e.status === 401){ st.pause = now + 15 * 60e3; await logAl(env, `⏸ ${src.nom} : ${e.message}, pause 15 min`); }
    else if (st.fails >= 3) st.pause = now + Math.min(10, st.fails) * 60e3;
  }
  const iv = Math.max(60, src.intervalle || CFG.intervalleParDefaut || 60) * 1000;
  st.next = now + iv * (0.8 + Math.random() * 0.4) - 20e3;     // -20 s : la minute suivante compte
  await putSt(env, k, st);
  return st.last;
}

async function etats(env){
  const rows = (await env.DB.prepare("SELECT k,v FROM st WHERE k LIKE 's:%'").all()).results || [];
  const m = Object.fromEntries(rows.map(r => [r.k.slice(2), JSON.parse(r.v)]));
  return CFG.sources.map((s, i) => ({i, actif: s.actif !== false, nom: s.nom, type: s.type, ...(({ok, err, last, next, pause}) => ({ok: ok || 0, err: err || 0, last: last || "", next: next || 0, pause: pause || 0}))(m[s.nom] || {})}));
}
async function bilan(env, label){
  const l = (await etats(env)).filter(s => s.actif), ok = l.filter(s => s.ok > 0 && !(s.pause > Date.now())), ko = l.filter(s => !(s.ok > 0) || s.pause > Date.now());
  await notify(env, {title: `Guetteur en ligne ${label} · ${ok.length}/${l.length} sources OK`,
    message: (ok.length ? "OK : " + ok.map(s => s.nom).join(", ") : "") + (ko.length ? "\nBloquées : " + ko.map(s => `${s.nom} (${s.last || "pas encore lue"})`).join(", ") : ""), priority: 2, tags: ["eyes"]});
}

export default {
  async scheduled(ev, env, ctx){
    await loadCfg(env); const now = Date.now();
    const rows = (await env.DB.prepare("SELECT k,v FROM st WHERE k LIKE 's:%'").all()).results || [];
    const nx = Object.fromEntries(rows.map(r => { const v = JSON.parse(r.v); return [r.k.slice(2), Math.max(v.next || 0, v.pause || 0)]; }));
    const due = SOURCES.map(s => ({nom: s.nom, at: nx[s.nom] || 0})).filter(x => x.at <= now).sort((a, b) => a.at - b.at).slice(0, 30);
    // chaque source dans sa propre exécution (limites de temps séparées)
    ctx.waitUntil(Promise.allSettled(due.map(x => env.SELF.fetch(`https://guetteur/run?n=${encodeURIComponent(x.nom)}`, {method: "POST", headers: {"x-cron": env.CRON_KEY || ""}}))));
    // bilans : 15 min après la mise en ligne, puis toutes les 6 h
    const meta = (await getSt(env, "meta")) || {start: now};
    if (!meta.start) meta.start = now;
    if (!meta.first && now - meta.start > 15 * 60e3){ meta.first = 1; meta.bilan = now; await putSt(env, "meta", meta); ctx.waitUntil(bilan(env, "démarré")); }
    else if (meta.first && now - (meta.bilan || 0) > 6 * 3600e3){ meta.bilan = now; await putSt(env, "meta", meta); ctx.waitUntil(bilan(env, "actif")); }
    else if (!rows.length || !meta.seen){ meta.seen = 1; await putSt(env, "meta", meta); }
    if (new Date().getUTCMinutes() === 0) ctx.waitUntil(env.DB.prepare("DELETE FROM log WHERE t < ?").bind(now - 14 * 864e5).run());
  },
  async fetch(req, env){
    const u = new URL(req.url); await loadCfg(env);
    if (u.pathname === "/reglages") return new Response(PAGE, {headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex"}});
    if (u.pathname.startsWith("/api/")) return api(req, env, u);
    if (u.pathname === "/alertes" || u.pathname.startsWith("/push/")) return pubApi(req, env, u);
    if (u.pathname === "/run" && req.method === "POST"){
      if ((req.headers.get("x-cron") || "") !== (env.CRON_KEY || "")) return new Response("non", {status: 403});
      return new Response(await runSource(env, u.searchParams.get("n")));
    }
    if (u.pathname === "/etat"){
      const l = (await etats(env)).filter(s => s.actif), logs = (await env.DB.prepare("SELECT t,l FROM log ORDER BY t DESC LIMIT 40").all()).results || [];
      const f = t => t ? new Date(t).toLocaleTimeString("fr-FR", {timeZone: "Europe/Paris"}) : "—";
      const esc = s => String(s).replace(/[&<>]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;"}[c]));
      return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Guetteur en ligne</title>
<style>body{font:14px system-ui;background:#0e0b18;color:#eee;margin:16px}td{padding:5px 8px;border-bottom:1px solid #2a2440;vertical-align:top}.ko{color:#ff8a8a}.ok{color:#7cf3b0}small{color:#9a93b8}</style>
<h2>Guetteur en ligne · ${l.filter(s => s.ok && !(s.pause > Date.now())).length}/${l.length} sources OK</h2><table>${l.map(s => `<tr><td class="${s.ok && !(s.pause > Date.now()) ? "ok" : "ko"}">${s.ok && !(s.pause > Date.now()) ? "✓" : "✗"}</td><td><b>${esc(s.nom)}</b><br><small>${esc(s.type)} · ${s.ok} lectures, ${s.err} erreurs${s.pause > Date.now() ? ` · en pause jusqu'à ${f(s.pause)}` : ""}</small></td><td>${esc(s.last)}</td></tr>`).join("")}</table>
<h3>Journal</h3>${logs.map(x => `<div><small>${new Date(x.t).toLocaleString("fr-FR", {timeZone: "Europe/Paris"})}</small> ${esc(x.l)}</div>`).join("")}`, {headers: {"content-type": "text/html; charset=utf-8", "cache-control": "no-store"}});
    }
    return new Response("Guetteur Dex Scan · /etat", {headers: {"content-type": "text/plain; charset=utf-8"}});
  }
};

// ---------- réglages (réservés au propriétaire : clé ADMIN_KEY) ----------
async function admin(req, env){
  const k = req.headers.get("x-admin") || "", a = new TextEncoder().encode(k), b = new TextEncoder().encode(env.ADMIN_KEY || "");
  return !!env.ADMIN_KEY && a.length === b.length && crypto.subtle.timingSafeEqual(a, b);
}
const TYPES = ["boutique", "shopify", "rss", "page", "produit"];
function valide(c){
  if (!c || !Array.isArray(c.sources)) throw new Error("réglages illisibles");
  for (const k of ["motsPokemon", "motsUrgents", "motsStock", "motsExclus", "motsTCGforts"]) { try { new RegExp(c[k] || "(?!)", "i"); } catch (e) { throw new Error(`« ${k} » : expression invalide`); } }
  const noms = new Set();
  c.sources = c.sources.map(s => {
    const nom = String(s.nom || "").trim().slice(0, 80); if (!nom) throw new Error("une source n'a pas de nom");
    if (noms.has(nom)) throw new Error(`deux sources s'appellent « ${nom} »`); noms.add(nom);
    if (!TYPES.includes(s.type)) throw new Error(`« ${nom} » : type inconnu`);
    let url; try { url = new URL(s.url); } catch (e) { throw new Error(`« ${nom} » : lien invalide`); }
    if (!/^https?:$/.test(url.protocol)) throw new Error(`« ${nom} » : lien invalide`);
    if (s.motsCles) try { new RegExp(s.motsCles, "i"); } catch (e) { throw new Error(`« ${nom} » : mots-clés invalides`); }
    const o = {...s, nom, url: url.href, intervalle: Math.min(3600, Math.max(60, Math.round(+s.intervalle || 60)))};
    if (o.actif !== false) delete o.actif;
    return o;
  });
  c.intervalleParDefaut = Math.min(3600, Math.max(60, +c.intervalleParDefaut || 60));
  c.rappelMin = Math.min(240, Math.max(0, Math.round(+c.rappelMin || 0)));
  c.alerterAuDemarrage = !!c.alerterAuDemarrage;
  setup(c); return c;
}
async function api(req, env, u){
  const J = (o, st = 200) => new Response(JSON.stringify(o), {status: st, headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store"}});
  if (!(await admin(req, env))) { await new Promise(r => setTimeout(r, 800)); return J({error: "Clé refusée"}, 403); }
  try {
    const p = u.pathname.slice(5);
    if (p === "cfg" && req.method === "GET") return J({cfg: CFG, perso: CFGV !== 0, etats: await etats(env)});
    if (p === "cfg" && req.method === "PUT"){ const c = valide((await req.json()).cfg); const t = Date.now();
      await env.DB.prepare("INSERT INTO st(k,v,t) VALUES('cfg',?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, t=excluded.t").bind(JSON.stringify(c), t).run(); CFGV = t;
      await logAl(env, "⚙️ réglages modifiés"); return J({ok: true, cfg: c, etats: await etats(env)}); }
    if (p === "origine" && req.method === "POST"){ await env.DB.prepare("DELETE FROM st WHERE k='cfg'").run(); CFGV = null; await loadCfg(env); await logAl(env, "⚙️ réglages d'origine remis"); return J({ok: true, cfg: CFG, etats: await etats(env)}); }
    if (p === "tester" && req.method === "POST"){ const nom = u.searchParams.get("n"), k = "s:" + nom, st = (await getSt(env, k)) || {}; st.pause = 0; await putSt(env, k, st);
      return J({res: await runSource(env, nom), etats: await etats(env)}); }
    if (p === "notif" && req.method === "POST"){ await notify(env, {title: "Test du guetteur", message: "Les alertes arrivent bien sur ce téléphone.", priority: 3, tags: ["white_check_mark"]}); return J({ok: true}); }
    return J({error: "inconnu"}, 404);
  } catch (e) { return J({error: e.message}, 400); }
}

const PAGE = `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">
<title>Réglages du guetteur</title><style>
:root{--bg:#0e0b18;--p:#1a1530;--p2:#241d40;--l:#342b55;--fg:#f1edff;--mu:#9a93b8;--a:#a06bff;--ok:#7cf3b0;--ko:#ff8a8a}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 -apple-system,system-ui,sans-serif;padding:max(16px,env(safe-area-inset-top)) 14px 120px}
h1{font-size:26px;margin:4px 0 4px}h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--mu);margin:26px 0 10px}
.card{background:var(--p);border:1px solid var(--l);border-radius:16px;padding:12px;margin-bottom:10px}
input,select,textarea{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--l);border-radius:10px;padding:10px;font:inherit;font-size:16px}
textarea{font:13px/1.4 ui-monospace,monospace;min-height:70px}label{display:block;font-size:12.5px;color:var(--mu);margin:10px 0 4px}
button{font:inherit;font-weight:700;border:0;border-radius:12px;padding:11px 14px;background:var(--p2);color:var(--fg);border:1px solid var(--l)}
.y{background:var(--a);border-color:var(--a);color:#fff}.row{display:flex;gap:8px;align-items:center}.row>*{flex:1}
.src{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:center}.src b{display:block}.src small{color:var(--mu);font-size:12px;display:block;overflow-wrap:anywhere}
.dot{width:10px;height:10px;border-radius:5px;background:var(--ko)}.dot.on{background:var(--ok)}.dot.off{background:#555}
.sw{position:relative;width:46px;height:28px;flex:none}.sw input{opacity:0;position:absolute}.sw i{position:absolute;inset:0;border-radius:14px;background:#3a3358;transition:.2s}.sw i:after{content:"";position:absolute;left:3px;top:3px;width:22px;height:22px;border-radius:11px;background:#fff;transition:.2s}.sw input:checked+i{background:var(--a)}.sw input:checked+i:after{left:21px}
details>summary{list-style:none;cursor:pointer}.more{margin-top:10px;padding-top:10px;border-top:1px solid var(--l)}
.chk{display:flex;gap:8px;align-items:center;font-size:14px;color:var(--fg);margin:8px 0}.chk input{width:20px;height:20px}
#bar{position:fixed;left:0;right:0;bottom:0;padding:12px 14px max(12px,env(safe-area-inset-bottom));background:rgba(14,11,24,.92);backdrop-filter:blur(10px);border-top:1px solid var(--l);display:flex;gap:8px}#bar button{flex:1}
#toast{position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#fff;color:#111;padding:10px 16px;border-radius:12px;font-weight:600;display:none;max-width:90%}
.mu{color:var(--mu);font-size:13px}
</style>
<h1>Réglages du guetteur</h1><p class="mu" id="sub">Réservé au propriétaire.</p>
<div id="login" hidden class="card"><label>Clé d'accès</label><input id="key" type="text" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="Colle ta clé ici"><button class="y" id="go" style="width:100%;margin-top:10px">Entrer</button></div>
<div id="app" hidden>
 <h2>Sources</h2><div id="list"></div>
 <h2>Ajouter une source</h2><div class="card">
  <label>Nom</label><input id="nNom" placeholder="Ex. Cultura Pokémon">
  <label>Type</label><select id="nType"><option value="page">Page de recherche d'un site</option><option value="shopify">Collection Shopify (products.json)</option><option value="boutique">Boutique entière (nouveaux produits + retours en stock)</option><option value="produit">Fiche produit précise (alerte quand dispo)</option><option value="rss">Flux RSS / Atom</option></select>
  <label>Lien</label><input id="nUrl" inputmode="url" placeholder="https://…">
  <label>Toutes les (secondes, 60 minimum)</label><input id="nIv" type="number" min="60" step="30" value="60">
  <button class="y" id="add" style="width:100%;margin-top:12px">Ajouter</button></div>
 <h2>Réglages généraux</h2><div class="card">
  <div class="row"><div><label>Intervalle par défaut (s)</label><input id="gIv" type="number" min="60"></div><div><label>Rappel si toujours dispo (min, 0 = jamais)</label><input id="gRap" type="number" min="0"></div></div>
  <label class="chk"><input type="checkbox" id="gStart"> Alerter aussi au premier passage d'une nouvelle source</label></div>
 <h2>Mots-clés</h2><div class="card">
  <label>Doit parler de Pokémon</label><textarea id="mP"></textarea>
  <label>Urgents (précommande, invitation…)</label><textarea id="mU"></textarea>
  <label>Stock (réassort, disponible…)</label><textarea id="mS"></textarea>
  <label>Exclus (bruit à ignorer)</label><textarea id="mX"></textarea>
  <label>Produits TCG jamais exclus</label><textarea id="mF"></textarea>
  <p class="mu">Format « expression régulière » : sépare les mots par une barre verticale | .</p></div>
 <h2>Outils</h2><div class="card"><button id="notif" style="width:100%">Envoyer une notification de test</button><button id="orig" style="width:100%;margin-top:8px">Revenir aux réglages d'origine</button><p class="mu" style="margin:10px 0 0"><a style="color:var(--a)" href="/etat">Voir l'état et le journal ›</a></p></div>
 <div id="bar"><button id="reload">Annuler</button><button class="y" id="save">Enregistrer</button></div>
</div><div id="toast"></div>
<script>
const $=s=>document.querySelector(s);let K="",C=null,E=[],dirty=false;
const toast=t=>{const e=$("#toast");e.textContent=t;e.style.display="block";clearTimeout(e._t);e._t=setTimeout(()=>e.style.display="none",2600)};
try{const m=location.hash.match(/k=([^&]+)/)||location.search.match(/[?&]k=([^&]+)/);if(m){localStorage.setItem("gk",decodeURIComponent(m[1]));history.replaceState(null,"",location.pathname)}K=localStorage.getItem("gk")||""}catch(e){}
async function call(p,o={}){const r=await fetch("/api/"+p,{...o,headers:{"x-admin":K,"content-type":"application/json"}});const j=await r.json().catch(()=>({error:"réponse illisible"}));if(r.status===403){try{localStorage.removeItem("gk")}catch(e){}K="";show()}if(j.error)throw new Error(j.error);return j}
const esc=s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const TY={page:"page",shopify:"Shopify",boutique:"boutique",produit:"fiche produit",rss:"RSS"};
function render(){
 const st=Object.fromEntries(E.map(e=>[e.nom,e]));
 $("#list").innerHTML=C.sources.map((s,i)=>{const e=st[s.nom]||{},on=s.actif!==false,okk=on&&e.ok&&!(e.pause>Date.now());
  return '<div class="card"><details><summary class="src"><span class="dot '+(on?(okk?"on":""):"off")+'"></span><span><b>'+esc(s.nom)+'</b><small>'+TY[s.type]+' · toutes les '+(s.intervalle||C.intervalleParDefaut)+' s'+(on?' · '+esc(e.last||"pas encore lue"):" · en pause")+'</small></span><label class="sw" onclick="event.stopPropagation()"><input type="checkbox" data-on="'+i+'" '+(on?"checked":"")+'><i></i></label></summary>'
  +'<div class="more"><label>Nom</label><input data-f="nom" data-i="'+i+'" value="'+esc(s.nom)+'"><label>Lien</label><input data-f="url" data-i="'+i+'" value="'+esc(s.url)+'"><label>Toutes les (secondes)</label><input type="number" min="60" data-f="intervalle" data-i="'+i+'" value="'+(s.intervalle||C.intervalleParDefaut)+'">'
  +(s.type!=="produit"&&s.type!=="boutique"?'<label class="chk"><input type="checkbox" data-c="toutAlerter" data-i="'+i+'" '+(s.toutAlerter?"checked":"")+'> Alerter chaque nouvel élément Pokémon TCG</label><label class="chk"><input type="checkbox" data-c="toutPokemon" data-i="'+i+'" '+(s.toutPokemon?"checked":"")+'> Tout ce qui vient d\\'ici parle de Pokémon</label>':'')
  +(s.type==="boutique"?'<label class="chk"><input type="checkbox" data-c="filtrePokemon" data-i="'+i+'" '+(s.filtrePokemon?"checked":"")+'> Ne garder que les produits Pokémon</label>':'')
  +(s.type==="produit"?'<label>Rappel si toujours dispo (min, vide = réglage général)</label><input type="number" min="0" data-f="rappelMin" data-i="'+i+'" value="'+(s.rappelMin??"")+'">':'')
  +'<label>Mots-clés obligatoires (facultatif)</label><input data-f="motsCles" data-i="'+i+'" value="'+esc(s.motsCles||"")+'">'
  +'<div class="row" style="margin-top:12px"><button data-t="'+esc(s.nom)+'">Tester maintenant</button><button data-del="'+i+'" style="color:var(--ko)">Supprimer</button></div></div></details></div>'}).join("");
 $("#gIv").value=C.intervalleParDefaut;$("#gRap").value=C.rappelMin??10;$("#gStart").checked=!!C.alerterAuDemarrage;
 $("#mP").value=C.motsPokemon||"";$("#mU").value=C.motsUrgents||"";$("#mS").value=C.motsStock||"";$("#mX").value=C.motsExclus||"";$("#mF").value=C.motsTCGforts||"";
 const n=C.sources.filter(s=>s.actif!==false).length;$("#sub").textContent=n+" sources actives sur "+C.sources.length;
}
const mark=()=>{dirty=true;$("#save").textContent="Enregistrer •"};
document.addEventListener("change",e=>{const t=e.target,i=+t.dataset.i;
 if(t.dataset.on!=null){C.sources[+t.dataset.on].actif=t.checked;mark();render();return}
 if(t.dataset.f){let v=t.value;if(t.type==="number")v=v===""?undefined:+v;C.sources[i][t.dataset.f]=v;mark();return}
 if(t.dataset.c){C.sources[i][t.dataset.c]=t.checked||undefined;mark();return}
 const g={gIv:"intervalleParDefaut",gRap:"rappelMin",mP:"motsPokemon",mU:"motsUrgents",mS:"motsStock",mX:"motsExclus",mF:"motsTCGforts"}[t.id];
 if(g){C[g]=t.type==="number"?+t.value:t.value;mark()} if(t.id==="gStart"){C.alerterAuDemarrage=t.checked;mark()}});
document.addEventListener("click",async e=>{const b=e.target.closest("button");if(!b)return;
 if(b.dataset.del!=null){if(confirm("Supprimer « "+C.sources[+b.dataset.del].nom+" » ?")){C.sources.splice(+b.dataset.del,1);mark();render()}}
 if(b.dataset.t){if(dirty){toast("Enregistre d'abord tes changements");return}b.disabled=true;b.textContent="Lecture…";try{const j=await call("tester?n="+encodeURIComponent(b.dataset.t),{method:"POST"});E=j.etats;toast(j.res);render()}catch(x){toast(x.message)}}});
$("#add").onclick=()=>{const nom=$("#nNom").value.trim(),url=$("#nUrl").value.trim();if(!nom||!/^https?:\\/\\//.test(url))return toast("Nom et lien obligatoires");
 if(C.sources.some(s=>s.nom===nom))return toast("Ce nom existe déjà");C.sources.push({nom,type:$("#nType").value,url,intervalle:Math.max(60,+$("#nIv").value||60)});$("#nNom").value=$("#nUrl").value="";mark();render();toast("Ajoutée : pense à enregistrer")};
$("#save").onclick=async()=>{$("#save").disabled=true;try{const j=await call("cfg",{method:"PUT",body:JSON.stringify({cfg:C})});C=j.cfg;E=j.etats;dirty=false;$("#save").textContent="Enregistrer";render();toast("Enregistré : pris en compte à la prochaine minute")}catch(x){toast(x.message)}$("#save").disabled=false};
$("#reload").onclick=()=>{dirty=false;$("#save").textContent="Enregistrer";load()};
$("#notif").onclick=async()=>{try{await call("notif",{method:"POST"});toast("Notification envoyée")}catch(x){toast(x.message)}};
$("#orig").onclick=async()=>{if(!confirm("Remettre tous les réglages d'origine ?"))return;try{const j=await call("origine",{method:"POST"});C=j.cfg;E=j.etats;dirty=false;render();toast("Réglages d'origine remis")}catch(x){toast(x.message)}};
async function load(){try{const j=await call("cfg");C=j.cfg;E=j.etats;render();$("#app").hidden=false;$("#login").hidden=true}catch(x){if(K)toast(x.message)}}
function show(){$("#app").hidden=!K;$("#login").hidden=!!K;if(!K)$("#sub").textContent="Réservé au propriétaire."}
$("#go").onclick=()=>{K=$("#key").value.trim();try{localStorage.setItem("gk",K)}catch(e){}show();load()};
window.onbeforeunload=()=>dirty?true:undefined;
show();if(K)load();
</script></html>`;


// ---------- alertes publiques + notifications Web Push (tous les téléphones abonnés depuis l'app) ----------
// Secrets : VAPID_PRIV (clé privée P-256, JWK), VAPID_PUB (clé publique, base64url). Tables D1 « al » et « subs ».
let PUB_READY = false;
async function pubTables(env){
  if (PUB_READY) return; PUB_READY = true;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS al(id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, title TEXT, msg TEXT, url TEXT, prio INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS subs(ep TEXT PRIMARY KEY, p256 TEXT, auth TEXT, t INTEGER, ok INTEGER)")]);
}
const b64u = a => btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = s => Uint8Array.from(atob(String(s).replace(/-/g, "+").replace(/_/g, "/") + "===".slice((String(s).length + 3) % 4)), c => c.charCodeAt(0));
const cat = (...l) => { const o = new Uint8Array(l.reduce((a, x) => a + x.length, 0)); let i = 0; for (const x of l){ o.set(x, i); i += x.length; } return o; };
const TE = new TextEncoder();
async function hmac(key, data){ const k = await crypto.subtle.importKey("raw", key, {name: "HMAC", hash: "SHA-256"}, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, data)); }
// chiffrement du message (RFC 8291, aes128gcm) pour un abonné
async function encrypt(sub, text){
  const ua = unb64u(sub.p256), auth = unb64u(sub.auth);
  const as = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, {name: "ECDH", namedCurve: "P-256"}, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({name: "ECDH", public: uaKey}, as.privateKey, 256));
  const prkKey = await hmac(auth, ecdh);
  const ikm = await hmac(prkKey, cat(TE.encode("WebPush: info\0"), ua, asPub, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16)), prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(TE.encode("Content-Encoding: aes128gcm\0"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(TE.encode("Content-Encoding: nonce\0"), new Uint8Array([1])))).slice(0, 12);
  const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({name: "AES-GCM", iv: nonce}, k, cat(TE.encode(text), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
const VAPID = new Map();
async function vapid(env, aud){
  const c = VAPID.get(aud); if (c && c.exp > Date.now() + 3600e3) return c.h;
  const key = await crypto.subtle.importKey("jwk", JSON.parse(env.VAPID_PRIV), {name: "ECDSA", namedCurve: "P-256"}, false, ["sign"]);
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600;
  const un = b64u(TE.encode(JSON.stringify({typ: "JWT", alg: "ES256"}))) + "." + b64u(TE.encode(JSON.stringify({aud, exp, sub: "https://sidneydbs.github.io/cote/"})));
  const sig = await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, key, TE.encode(un));
  const h = `vapid t=${un}.${b64u(sig)}, k=${env.VAPID_PUB}`;
  VAPID.set(aud, {h, exp: exp * 1000}); return h;
}
async function pushOne(env, sub, text, urgent){
  const ep = new URL(sub.ep);
  const r = await fetch(sub.ep, {method: "POST", body: await encrypt(sub, text), headers: {
    "authorization": await vapid(env, ep.origin), "content-encoding": "aes128gcm", "content-type": "application/octet-stream",
    "ttl": "21600", "urgency": urgent ? "high" : "normal", "topic": "dexscan"}});
  if (r.status === 404 || r.status === 410) await env.DB.prepare("DELETE FROM subs WHERE ep=?").bind(sub.ep).run();
  else await env.DB.prepare("UPDATE subs SET ok=? WHERE ep=?").bind(r.status, sub.ep).run();
  return r.status;
}
async function pubAlert(env, {title, message, url, priority}){
  await pubTables(env); const t = Date.now();
  const r = await env.DB.prepare("INSERT INTO al(t,title,msg,url,prio) VALUES(?,?,?,?,?)").bind(t, title.slice(0, 250), message.slice(0, 900), url || "", priority).run();
  if (new Date().getUTCMinutes() === 0) await env.DB.prepare("DELETE FROM al WHERE t < ?").bind(t - 14 * 864e5).run();
  if (!env.VAPID_PRIV || !env.VAPID_PUB) return;
  const subs = (await env.DB.prepare("SELECT ep,p256,auth FROM subs").all()).results || [];
  const text = JSON.stringify({id: r.meta?.last_row_id, title, body: message, url: url || "", t});
  for (let i = 0; i < subs.length; i += 40)
    await Promise.allSettled(subs.slice(i, i + 40).map(s => pushOne(env, s, text, priority >= 5)));
}
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|push\.apple\.com|notify\.windows\.com|push\.services\.mozilla\.com)$/;
async function pubApi(req, env, u){
  const H = {"content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "no-store"};
  const J = (o, st = 200) => new Response(JSON.stringify(o), {status: st, headers: H});
  if (req.method === "OPTIONS") return new Response(null, {headers: H});
  await pubTables(env);
  try {
    if (u.pathname === "/alertes"){
      const since = Math.max(+u.searchParams.get("depuis") || 0, Date.now() - 7 * 864e5);
      const l = (await env.DB.prepare("SELECT id,t,title,msg,url,prio FROM al WHERE t > ? ORDER BY t DESC LIMIT 200").bind(since).all()).results || [];
      return J({items: l});
    }
    if (u.pathname === "/push/cle") return J({key: env.VAPID_PUB || null});
    if (u.pathname === "/push/abo" && req.method === "POST"){
      const b = await req.json(), s = b.sub || {}, ep = String(s.endpoint || "");
      let h; try { h = new URL(ep); } catch (e) { return J({error: "abonnement invalide"}, 400); }
      if (h.protocol !== "https:" || !PUSH_HOSTS.test(h.hostname) || !s.keys?.p256dh || !s.keys?.auth || ep.length > 1000) return J({error: "abonnement invalide"}, 400);
      const n = (await env.DB.prepare("SELECT COUNT(*) n FROM subs").first()).n; if (n > 5000) return J({error: "trop d'abonnés"}, 429);
      await env.DB.prepare("INSERT INTO subs(ep,p256,auth,t,ok) VALUES(?,?,?,?,1) ON CONFLICT(ep) DO UPDATE SET p256=excluded.p256, auth=excluded.auth, t=excluded.t").bind(ep, String(s.keys.p256dh).slice(0, 200), String(s.keys.auth).slice(0, 60), Date.now()).run();
      if (b.test) await pushOne(env, {ep, p256: s.keys.p256dh, auth: s.keys.auth}, JSON.stringify({title: "Notifications activées ✔", body: "Tu seras prévenu des réassorts et des sorties Pokémon dès que le guetteur les voit.", url: "", t: Date.now()}), false);
      return J({ok: true});
    }
    // état d'un téléphone (abonné ?) et notification de test à ce seul téléphone
    if (u.pathname === "/push/etat" && req.method === "POST"){ const b = await req.json(); const r = await env.DB.prepare("SELECT ok FROM subs WHERE ep=?").bind(String(b.endpoint || "")).first(); return J({abonne: !!r, dernier: r?.ok ?? null}); }
    if (u.pathname === "/push/test" && req.method === "POST"){
      const b = await req.json(), sub = await env.DB.prepare("SELECT ep,p256,auth,t FROM subs WHERE ep=?").bind(String(b.endpoint || "")).first();
      if (!sub) return J({error: "Ce téléphone n'est pas abonné"}, 404);
      const st = await pushOne(env, sub, JSON.stringify({title: "Test Dex Scan ✔", body: "Les notifications de réassort arrivent bien sur ce téléphone.", url: "", t: Date.now()}), true);
      return J({ok: st >= 200 && st < 300, status: st});
    }
    if (u.pathname === "/push/stop" && req.method === "POST"){ const b = await req.json(); await env.DB.prepare("DELETE FROM subs WHERE ep=?").bind(String(b.endpoint || "")).run(); return J({ok: true}); }
    return J({error: "inconnu"}, 404);
  } catch (e) { return J({error: e.message}, 400); }
}
