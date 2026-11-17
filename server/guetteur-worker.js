/* Guetteur Dex Scan — version en ligne (Cloudflare Worker + D1), réunit les deux guetteurs du PC :
   - « guetteur » (Node) : boutiques, flux RSS, pages de recherche, fiches produit
   - « Guetteur Pokemon » (PowerShell) : fiches produit précises + rappel toutes les 10 min tant que c'est dispo
   Toutes les minutes (déclencheur cron), chaque source dont c'est l'heure est relue dans sa propre exécution.
   Liaisons du Worker : DB (base D1), SELF (le Worker lui-même), NTFY_TOPIC (canal ntfy, gardé secret).
   Réglages : guetteur-config.txt (même format que config.json du PC, sans le canal ntfy). */
import RAW from "./guetteur-config.txt";
const CFG = JSON.parse(RAW);

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 DexScanGuetteur/1.0";
const POKE = new RegExp(CFG.motsPokemon, "i"), HOT = new RegExp(CFG.motsUrgents, "i"), STOCK = new RegExp(CFG.motsStock, "i"), NOPE = new RegExp(CFG.motsExclus, "i");
const sansAcc = x => String(x).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const motRe = w => sansAcc(w).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/[\s\-–'’&]+/g, "[\\s\\-–'’&]*");
const TCG_RE = CFG.tcg ? new RegExp(`(^|[^a-z0-9])(${[...CFG.tcg.produits, ...CFG.tcg.extensions].map(motRe).join("|")})(?=$|[^a-z0-9])` + (CFG.tcg.codes ? `|${CFG.tcg.codes}` : ""), "i") : /./;
const TCG = t => TCG_RE.test(sansAcc(t));
const FORT = new RegExp(CFG.motsTCGforts || "(?!)", "i");
const exclu = t => NOPE.test(t) && !(FORT.test(t) && !/peluche|carte cadeau|jeu vid[ée]o|switch|sleeves?|blind ?box/i.test(t));
const decode = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const SOURCES = CFG.sources.filter(s => s.actif !== false);
const MAX_SEEN = 1500, MAX_BODY = 700000;
const httpErr = (st, m) => Object.assign(new Error(m || "HTTP " + st), {status: st});
const prixTxt = p => p ? ` — ${(+p).toFixed(2).replace(".", ",")} €` : "";
const heure = () => new Date().toLocaleTimeString("fr-FR", {timeZone: "Europe/Paris"});

// ---------- état (D1 : une ligne par source) ----------
async function getSt(env, k){ const r = await env.DB.prepare("SELECT v FROM st WHERE k=?").bind(k).first(); return r ? JSON.parse(r.v) : null; }
async function putSt(env, k, v){ await env.DB.prepare("INSERT INTO st(k,v,t) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, t=excluded.t").bind(k, JSON.stringify(v), Date.now()).run(); }
async function logAl(env, line){ await env.DB.prepare("INSERT INTO log(t,l) VALUES(?,?)").bind(Date.now(), line.slice(0, 600)).run(); }

// ---------- notification iPhone (ntfy) ----------
async function notify(env, {title, message, url, priority = 4, tags = []}){
  await logAl(env, `🔔 ${title} — ${message} ${url || ""}`);
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
      return {id, title, url: link, text: title + " " + desc};
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
    await notify(env, {title: `${kind} · ${src.nom}`, message: x.title, url: x.url, priority: kind === "INVITATION" || kind === "PRÉCOMMANDE" ? 5 : 4,
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
      await notify(env, {title: `${kind} · ${src.nom}`, message: `${p.title}${prixTxt(price)}${avail ? "" : " (pas encore en stock)"}`, url, priority: kind === "NOUVEAU" && !avail ? 4 : 5, tags: [kind === "NOUVEAU" ? "new" : "rotating_light"]}); n++;
    } else if (avail){ await notify(env, {title: `DISPO · ${src.nom}`, message: `De retour en stock : ${p.title}${prixTxt(price)}`, url, priority: 5, tags: ["rotating_light"]}); n++; }
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
    await notify(env, {title: `${kind} · ${src.nom}`, message: `${st.dispo === true ? "Toujours en stock" : "EN STOCK"} : ${p.title}${prixTxt(p.price)}`, url: src.url, priority: 5, tags: ["rotating_light"]});
    st.alerte = now;
  }
  st.dispo = !!p.avail;
  return p.avail ? "EN STOCK" : "rupture";
}

// ---------- une source = une exécution ----------
async function runSource(env, i){
  const src = SOURCES[i]; if (!src) return "source inconnue";
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
  return SOURCES.map((s, i) => ({i, nom: s.nom, type: s.type, ...(({ok, err, last, next, pause}) => ({ok: ok || 0, err: err || 0, last: last || "", next: next || 0, pause: pause || 0}))(m[s.nom] || {})}));
}
async function bilan(env, label){
  const l = await etats(env), ok = l.filter(s => s.ok > 0 && !(s.pause > Date.now())), ko = l.filter(s => !(s.ok > 0) || s.pause > Date.now());
  await notify(env, {title: `Guetteur en ligne ${label} · ${ok.length}/${l.length} sources OK`,
    message: (ok.length ? "OK : " + ok.map(s => s.nom).join(", ") : "") + (ko.length ? "\nBloquées : " + ko.map(s => `${s.nom} (${s.last || "pas encore lue"})`).join(", ") : ""), priority: 2, tags: ["eyes"]});
}

export default {
  async scheduled(ev, env, ctx){
    const now = Date.now();
    const rows = (await env.DB.prepare("SELECT k,v FROM st WHERE k LIKE 's:%'").all()).results || [];
    const nx = Object.fromEntries(rows.map(r => { const v = JSON.parse(r.v); return [r.k.slice(2), Math.max(v.next || 0, v.pause || 0)]; }));
    const due = SOURCES.map((s, i) => ({i, at: nx[s.nom] || 0})).filter(x => x.at <= now).sort((a, b) => a.at - b.at).slice(0, 30);
    // chaque source dans sa propre exécution (limites de temps séparées)
    ctx.waitUntil(Promise.allSettled(due.map(x => env.SELF.fetch(`https://guetteur/run?i=${x.i}`, {method: "POST", headers: {"x-cron": env.CRON_KEY || ""}}))));
    // bilans : 15 min après la mise en ligne, puis toutes les 6 h
    const meta = (await getSt(env, "meta")) || {start: now};
    if (!meta.start) meta.start = now;
    if (!meta.first && now - meta.start > 15 * 60e3){ meta.first = 1; meta.bilan = now; await putSt(env, "meta", meta); ctx.waitUntil(bilan(env, "démarré")); }
    else if (meta.first && now - (meta.bilan || 0) > 6 * 3600e3){ meta.bilan = now; await putSt(env, "meta", meta); ctx.waitUntil(bilan(env, "actif")); }
    else if (!rows.length || !meta.seen){ meta.seen = 1; await putSt(env, "meta", meta); }
    if (new Date().getUTCMinutes() === 0) ctx.waitUntil(env.DB.prepare("DELETE FROM log WHERE t < ?").bind(now - 14 * 864e5).run());
  },
  async fetch(req, env){
    const u = new URL(req.url);
    if (u.pathname === "/run" && req.method === "POST"){
      if ((req.headers.get("x-cron") || "") !== (env.CRON_KEY || "")) return new Response("non", {status: 403});
      return new Response(await runSource(env, +u.searchParams.get("i")));
    }
    if (u.pathname === "/etat"){
      const l = await etats(env), logs = (await env.DB.prepare("SELECT t,l FROM log ORDER BY t DESC LIMIT 40").all()).results || [];
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
