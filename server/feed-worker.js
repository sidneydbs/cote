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
   Identité : l'id et la clé du profil de dresseur du téléphone. La 1re fois, le serveur retient
   l'empreinte de la clé ; ensuite seule cette clé peut publier ou réagir avec cet id. */
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
const load = async env => (await env.FEED.get("posts", "json")) || [];
const save = (env, l) => env.FEED.put("posts", JSON.stringify(l.slice(0, MAX_POSTS)));
function view(p, me, base){
  const v = p.votes || {}, vals = Object.values(v);
  return {id:p.id, uid:p.uid, name:p.name, pk:p.pk, lv:p.lv, tag:p.tag, text:p.text, shop:p.shop, price:p.price, t:p.t,
    img: p.img ? base + "/feed/img/" + p.id : undefined,
    likes:(p.likers||[]).length, liked: !!me && (p.likers||[]).includes(me),
    ok: vals.filter(x=>x==="ok").length, ko: vals.filter(x=>x==="ko").length, my: me ? (v[me] || null) : null,
    cm: (p.cm||[]).map(c => ({id:c.id, uid:c.uid, name:c.name, pk:c.pk, lv:c.lv, text:c.text, t:c.t}))};
}
export default {
  async fetch(req, env){
    const u = new URL(req.url), base = u.origin;
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
      let l = await load(env);
      if(act === "post"){
        const now = Date.now();
        if(l.filter(p => p.uid === me && now - p.t < 36e5).length >= PER_HOUR) return err("Trop de publications : réessaie dans un moment", 429);
        const text = clean(b.text, 500), img = typeof b.img === "string" && b.img.startsWith("data:image/") && b.img.length < 900000 ? b.img : null;
        if(text.length < 3 && !img) return err("Publication vide");
        const p = {id: now.toString(36) + Math.random().toString(36).slice(2, 7), uid:me, name:clean(b.name, 24) || "Dresseur",
          pk:clean(b.pk, 40) || undefined, lv:Math.max(1, Math.min(999, b.lv|0)), tag: b.tag === "re" ? "re" : "new", text,
          shop: b.tag === "re" ? clean(b.shop, 60) || undefined : undefined,
          price: b.tag === "re" && isFinite(+b.price) && b.price != null ? Math.round(+b.price * 100) / 100 : undefined,
          t:now, likers:[], votes:{}, reports:[], img: !!img};
        if(img) await env.FEED.put("img:" + p.id, img);
        l.unshift(p);
        for(const x of l.slice(MAX_POSTS)) if(x.img) await env.FEED.delete("img:" + x.id);
        await save(env, l);
        return json({post: view(p, me, base)});
      }
      const p = l.find(x => x.id === b.post); if(!p) return err("Ce post n'existe plus", 404);
      if(act === "like"){ p.likers ||= []; const i = p.likers.indexOf(me); i < 0 ? p.likers.push(me) : p.likers.splice(i, 1); }
      else if(act === "vote"){ if(p.tag !== "re") return err("Vote réservé aux réassorts"); const v = b.v === "ko" ? "ko" : "ok"; p.votes ||= {}; p.votes[me] === v ? delete p.votes[me] : p.votes[me] = v; }
      else if(act === "del"){ if(p.uid !== me) return err("Ce n'est pas ton post", 403); l = l.filter(x => x !== p); if(p.img) await env.FEED.delete("img:" + p.id); await save(env, l); return json({ok:true}); }
      else if(act === "comment"){
        const text = clean(b.text, 300); if(!text) return err("Commentaire vide");
        const now = Date.now(); let n = 0; for(const x of l) for(const c of (x.cm||[])) if(c.uid === me && now - c.t < 36e5) n++;
        if(n >= CM_PER_HOUR) return err("Trop de commentaires : réessaie dans un moment", 429);
        p.cm ||= []; if(p.cm.length >= MAX_CM) return err("Ce post a trop de commentaires");
        p.cm.push({id: now.toString(36) + Math.random().toString(36).slice(2, 6), uid:me, name:clean(b.name, 24) || "Dresseur", pk:clean(b.pk, 40) || undefined, lv:Math.max(1, Math.min(999, b.lv|0)), text, t:now});
      }
      else if(act === "uncomment"){ const c = (p.cm||[]).find(x => x.id === b.c); if(!c) return err("Commentaire introuvable", 404); if(c.uid !== me && p.uid !== me) return err("Ce n'est pas ton commentaire", 403); p.cm = p.cm.filter(x => x !== c); }
      else if(act === "report"){ p.reports ||= []; if(!p.reports.includes(me)) p.reports.push(me); await save(env, l); return json({ok:true}); }
      else return err("action inconnue", 404);
      await save(env, l);
      return json({post: view(p, me, base)});
    }catch(e){ return err(e.message || "erreur serveur", 400); }
  }
};
