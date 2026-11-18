/* Dex Scan — serveur du Fil (Cloudflare Worker + KV)
   Liaison KV obligatoire : nom de variable FEED.
   Routes (toutes sous /feed) :
     GET  /feed?f=all|re|new&id=ID      → {posts}
     GET  /feed/img/POST_ID              → la photo (JPEG)
     POST /feed/post   {id,key,name,pk,lv,tag,text,img,shop,price} → {post}
     POST /feed/like   {id,key,post}     → {post}
     POST /feed/vote   {id,key,post,v}   → {post}   (v = "ok" | "ko")
     POST /feed/del    {id,key,post}     → {ok}
     POST /feed/report {id,key,post}     → {ok}
     POST /feed/comment   {id,key,post,name,pk,lv,text} → {post}   (commentaire)
     POST /feed/uncomment {id,key,post,c}                → {post}   (par son auteur ou l'auteur du post)
     POST /feed/pvote  {id,key,post,o}   → {post}   (sondage : o = numéro de l'option)
   Messages privés (KV "dm:A:B" = la conversation, "inbox:ID" = mes conversations) :
     POST /feed/dm/send   {id,key,to,toName,toPk,name,pk,text,card} → {msg}
     POST /feed/dm/list   {id,key}            → {threads:[{with,name,pk,last,t,unread}]}
     POST /feed/dm/thread {id,key,with}       → {msgs}   (et marque la conversation comme lue)
   Modes (tag) : talk, re, new, trade, card, col, open, want, sell, poll.
   att (pièce jointe) selon le mode : card/want {card} · trade {give,want} · sell {card,ask} · col {n,val,sets,cards[]}
   · open {prod,cost,cards[]} · poll {opts[]}. Une carte = {id,name,set,num,img,price,rar}.
   Identité : l'id et la clé du profil de dresseur du téléphone. La 1re fois, le serveur retient
   l'empreinte de la clé ; ensuite seule cette clé peut publier ou réagir avec cet id. */
const TAGS = ["talk","re","new","trade","card","col","open","want","sell","poll"];
const MAX_POSTS = 300, HIDE_AT = 3, PER_HOUR = 12, MAX_CM = 200, CM_PER_HOUR = 40;
const CORS = {"access-control-allow-origin":"*", "access-control-allow-methods":"GET,POST,OPTIONS", "access-control-allow-headers":"content-type"};
const json = (o, s=200) => new Response(JSON.stringify(o), {status:s, headers:{"content-type":"application/json; charset=utf-8", "cache-control":"no-store", ...CORS}});
const err = (m, s=400) => json({error:m}, s);
const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);
async function sha(s){ const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join(""); }
async function auth(env, id, key){
  id = clean(id, 64); key = String(key || "");
  if(!/^[\w-]{6,64}$/.test(id) || key.length < 8) throw new Error("Profil de dresseur invalide");
  const h = await sha(key), k = "key:" + id, old = await env.FEED.get(k);
  if(!old) await env.FEED.put(k, h); else if(old !== h) throw new Error("Ce profil appartient à un autre téléphone");
  return id;
}
const num = (v, max=1e7) => v == null || v === "" || !isFinite(+v) ? undefined : Math.max(0, Math.min(max, Math.round(+v * 100) / 100));
function card(c){ if(!c || typeof c !== "object") return undefined; const img = typeof c.img === "string" && /^https:\/\/[^\s"'<>]{4,300}$/.test(c.img) ? c.img : undefined;
  const o = {id:clean(c.id, 48), name:clean(c.name, 60), set:clean(c.set, 60) || undefined, num:clean(c.num, 16) || undefined, img, price:num(c.price), rar:clean(c.rar, 40) || undefined};
  return o.name ? o : undefined; }
function attOf(tag, a){
  if(!a || typeof a !== "object") return undefined;
  if(tag === "card" || tag === "want"){ const c = card(a.card); return c ? {card:c} : undefined; }
  if(tag === "trade"){ const g = card(a.give), w = card(a.want); return g && w ? {give:g, want:w} : undefined; }
  if(tag === "sell"){ const c = card(a.card); return c ? {card:c, ask:num(a.ask)} : undefined; }
  if(tag === "col"){ const l = (Array.isArray(a.cards) ? a.cards : []).slice(0, 9).map(card).filter(Boolean); return l.length ? {n:num(a.n, 1e6), val:num(a.val), sets:num(a.sets, 5000), cards:l} : undefined; }
  if(tag === "open"){ const l = (Array.isArray(a.cards) ? a.cards : []).slice(0, 12).map(card).filter(Boolean); return {prod:clean(a.prod, 60) || undefined, cost:num(a.cost), cards:l}; }
  if(tag === "poll"){ const o = (Array.isArray(a.opts) ? a.opts : []).map(x => clean(x, 60)).filter(Boolean).slice(0, 4); return o.length >= 2 ? {opts:o} : undefined; }
}
const load = async env => (await env.FEED.get("posts", "json")) || [];
const save = (env, l) => env.FEED.put("posts", JSON.stringify(l.slice(0, MAX_POSTS)));
function view(p, me, base){
  const v = p.votes || {}, vals = Object.values(v);
  return {id:p.id, uid:p.uid, name:p.name, pk:p.pk, lv:p.lv, tag:p.tag, text:p.text, shop:p.shop, price:p.price, t:p.t,
    img: p.img ? base + "/feed/img/" + p.id : undefined,
    likes:(p.likers||[]).length, liked: !!me && (p.likers||[]).includes(me),
    ok: vals.filter(x=>x==="ok").length, ko: vals.filter(x=>x==="ko").length, my: me ? (v[me] || null) : null,
    cm: (p.cm||[]).map(c => ({id:c.id, uid:c.uid, name:c.name, pk:c.pk, lv:c.lv, text:c.text, card:c.card, t:c.t})),
    att:p.att, city:p.city,
    pv: p.att?.opts ? p.att.opts.map((_, i) => Object.values(p.pv||{}).filter(x => x === i).length) : undefined,
    mpv: me && p.pv && p.pv[me] != null ? p.pv[me] : null};
}
/* ---- notifications sur les téléphones : envoyées par le guetteur (liaison de service PUSH, clé INT_KEY) ---- */
function notif(env, path, body){
  if(!env.PUSH || !env.INT_KEY) return;
  const p = env.PUSH.fetch("https://guetteur/push/int/" + path, {method:"POST", headers:{"content-type":"application/json", "x-int":env.INT_KEY}, body:JSON.stringify(body)}).catch(()=>{});
  env.__ctx ? env.__ctx.waitUntil(p) : null;
}
const TAG_TXT = {talk:"💬 Discussion", re:"🔔 Réassort", new:"✨ Nouveauté", trade:"⇄ Échange", card:"🃏 Ma carte", col:"📚 Ma collec", open:"🎁 Ouverture", want:"🔍 Je cherche", sell:"💰 Je vends", poll:"📊 Sondage"};
/* ---- messages privés ---- */
const DM_MAX = 400, DM_PER_HOUR = 120;
const dmKey = (a, b) => "dm:" + [a, b].sort().join(":");
const inboxOf = async (env, id) => (await env.FEED.get("inbox:" + id, "json")) || [];
async function dm(env, me, act, b){
  if(act === "list") return json({threads: (await inboxOf(env, me)).sort((x, y) => y.t - x.t)});
  const other = clean(b.with ?? b.to, 64); if(!/^[\w-]{6,64}$/.test(other) || other === me) return err("Destinataire invalide");
  if(act === "thread"){
    const l = (await env.FEED.get(dmKey(me, other), "json")) || [];
    const ib = await inboxOf(env, me), e = ib.find(x => x.with === other); if(e && e.unread){ e.unread = 0; await env.FEED.put("inbox:" + me, JSON.stringify(ib)); }
    return json({msgs: l.slice(-200)});
  }
  if(act === "send"){
    const text = clean(b.text, 1000), c = card(b.card); if(!text && !c) return err("Message vide");
    const now = Date.now(), rk = "dmr:" + me, r = (await env.FEED.get(rk, "json")) || {h:0, n:0};
    if(now - r.h > 36e5){ r.h = now; r.n = 0; } if(++r.n > DM_PER_HOUR) return err("Trop de messages : réessaie dans un moment", 429);
    await env.FEED.put(rk, JSON.stringify(r));
    const m = {id: now.toString(36) + Math.random().toString(36).slice(2, 6), from:me, text, card:c, t:now};
    const k = dmKey(me, other), l = (await env.FEED.get(k, "json")) || []; l.push(m); await env.FEED.put(k, JSON.stringify(l.slice(-DM_MAX)));
    const last = text || "🃏 " + (c?.name || "Carte");
    const upd = async (owner, w, name, pk, unread) => { const ib = await inboxOf(env, owner); let e = ib.find(x => x.with === w);
      if(!e){ e = {with:w, unread:0}; ib.push(e); } if(name) e.name = clean(name, 24); if(pk) e.pk = clean(pk, 40); e.last = last.slice(0, 120); e.t = now; e.unread = unread ? (e.unread||0) + 1 : 0;
      await env.FEED.put("inbox:" + owner, JSON.stringify(ib.sort((x, y) => y.t - x.t).slice(0, 200))); };
    await upd(me, other, b.toName, b.toPk, false);
    await upd(other, me, b.name, b.pk, true);
    notif(env, "send", {kind:"dm", to:other, tag:"dm-" + me, title:`💬 ${clean(b.name, 24) || "Un Hunter"}`, body:last.slice(0, 200), url:`app:?msg=${encodeURIComponent(me)}`});
    return json({msg: m});
  }
  return err("action inconnue", 404);
}
export default {
  async fetch(req, env, ctx){
    const u = new URL(req.url), base = u.origin; env.__ctx = ctx;
    if(req.method === "OPTIONS") return new Response(null, {headers:CORS});
    if(!env.FEED) return err("Liaison KV « FEED » manquante sur le Worker", 500);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    try{
      if(req.method === "GET" && (path === "/feed" || path === "/")){
        const f = u.searchParams.get("f") || "all", me = clean(u.searchParams.get("id"), 64);
        let l = (await load(env)).filter(p => (p.reports||[]).length < HIDE_AT && (f === "all" || p.tag === f));
        if(u.searchParams.get("peek")) l = l.slice(0, 1);
        return json({posts: l.slice(0, 150).map(p => view(p, me, base))});
      }
      if(req.method === "GET" && path.startsWith("/feed/img/")){
        const d = await env.FEED.get("img:" + path.slice(10));
        if(!d) return new Response("introuvable", {status:404, headers:CORS});
        const m = d.match(/^data:(image\/[\w+.-]+);base64,(.+)$/); if(!m) return new Response("illisible", {status:500, headers:CORS});
        const bin = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
        return new Response(bin, {headers:{"content-type":m[1], "cache-control":"public, max-age=31536000, immutable", ...CORS}});
      }
      if(req.method !== "POST" || !path.startsWith("/feed/")) return err("route inconnue", 404);
      const b = await req.json().catch(()=>null); if(!b) return err("requête illisible");
      const me = await auth(env, b.id, b.key), act = path.slice(6);
      if(act.startsWith("dm/")) return await dm(env, me, act.slice(3), b);
      // relie l'abonnement aux notifications de ce téléphone à ce profil (pour recevoir ses messages privés)
      if(act === "pushlink"){ if(!/^https:\/\/[^\s]{10,1000}$/.test(String(b.endpoint || ""))) return err("Abonnement invalide");
        if(!env.PUSH || !env.INT_KEY) return err("Notifications indisponibles", 503);
        const r = await env.PUSH.fetch("https://guetteur/push/int/link", {method:"POST", headers:{"content-type":"application/json", "x-int":env.INT_KEY}, body:JSON.stringify({uid:me, endpoint:b.endpoint})}).then(r=>r.json()).catch(()=>({}));
        return json({ok: !!r.ok}); }
      let l = await load(env);
      if(act === "post"){
        const now = Date.now();
        if(l.filter(p => p.uid === me && now - p.t < 36e5).length >= PER_HOUR) return err("Trop de publications : réessaie dans un moment", 429);
        const text = clean(b.text, 500), img = typeof b.img === "string" && b.img.startsWith("data:image/") && b.img.length < 900000 ? b.img : null;
        const tag = TAGS.includes(b.tag) ? b.tag : "talk", att = attOf(tag, b.att);
        if(["trade","card","col","want","sell","poll"].includes(tag) && !att) return err("Il manque la carte ou les options de ta publication");
        if(text.length < 3 && !img && !att) return err("Publication vide");
        const p = {id: now.toString(36) + Math.random().toString(36).slice(2, 7), uid:me, name:clean(b.name, 24) || "Dresseur",
          pk:clean(b.pk, 40) || undefined, lv:Math.max(1, Math.min(999, b.lv|0)), tag, text, att, city:clean(b.city, 40) || undefined,
          shop: tag === "re" ? clean(b.shop, 60) || undefined : undefined,
          price: tag === "re" && isFinite(+b.price) && b.price != null ? Math.round(+b.price * 100) / 100 : undefined,
          t:now, likers:[], votes:{}, reports:[], img: !!img};
        if(img) await env.FEED.put("img:" + p.id, img);
        l.unshift(p);
        for(const x of l.slice(MAX_POSTS)) if(x.img) await env.FEED.delete("img:" + x.id);
        await save(env, l);
        const what = p.att?.card?.name || p.att?.give?.name || p.att?.prod || (p.tag === "re" && p.shop ? p.shop : "");
        notif(env, "send", {kind:"post", except:me, tag:"post-" + p.id, title:`${TAG_TXT[tag] || "Fil"} · ${p.name}`, body:(text || what || "Nouvelle publication sur le Fil").slice(0, 200), url:`app:?post=${p.id}`});
        return json({post: view(p, me, base)});
      }
      const p = l.find(x => x.id === b.post); if(!p) return err("Ce post n'existe plus", 404);
      if(act === "like"){ p.likers ||= []; const i = p.likers.indexOf(me); i < 0 ? p.likers.push(me) : p.likers.splice(i, 1); }
      else if(act === "vote"){ if(p.tag !== "re") return err("Vote réservé aux réassorts"); const v = b.v === "ko" ? "ko" : "ok"; p.votes ||= {}; p.votes[me] === v ? delete p.votes[me] : p.votes[me] = v; }
      else if(act === "del"){ if(p.uid !== me) return err("Ce n'est pas ton post", 403); l = l.filter(x => x !== p); if(p.img) await env.FEED.delete("img:" + p.id); await save(env, l); return json({ok:true}); }
      else if(act === "comment"){
        const text = clean(b.text, 300); if(!text && !b.card) return err("Commentaire vide");
        const now = Date.now(); let n = 0; for(const x of l) for(const c of (x.cm||[])) if(c.uid === me && now - c.t < 36e5) n++;
        if(n >= CM_PER_HOUR) return err("Trop de commentaires : réessaie dans un moment", 429);
        p.cm ||= []; if(p.cm.length >= MAX_CM) return err("Ce post a trop de commentaires");
        p.cm.push({id: now.toString(36) + Math.random().toString(36).slice(2, 6), uid:me, name:clean(b.name, 24) || "Dresseur", pk:clean(b.pk, 40) || undefined, lv:Math.max(1, Math.min(999, b.lv|0)), text, card:card(b.card), t:now});
      }
      else if(act === "uncomment"){ const c = (p.cm||[]).find(x => x.id === b.c); if(!c) return err("Commentaire introuvable", 404); if(c.uid !== me && p.uid !== me) return err("Ce n'est pas ton commentaire", 403); p.cm = p.cm.filter(x => x !== c); }
      else if(act === "pvote"){ const n = p.att?.opts?.length || 0, o = b.o|0; if(!n || o < 0 || o >= n) return err("Option inconnue"); p.pv ||= {}; p.pv[me] === o ? delete p.pv[me] : p.pv[me] = o; }
      else if(act === "report"){ p.reports ||= []; if(!p.reports.includes(me)) p.reports.push(me); await save(env, l); return json({ok:true}); }
      else return err("action inconnue", 404);
      await save(env, l);
      return json({post: view(p, me, base)});
    }catch(e){ return err(e.message || "erreur serveur", 400); }
  }
};
