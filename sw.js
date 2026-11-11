// Dex Scan : service worker.
// - L'app (index.html) est toujours chargée à jour depuis le réseau ; sans réseau, une page d'attente.
// - Les images des cartes, logos et icônes sont gardées sur le téléphone : la 2e fois elles s'affichent tout de suite,
//   sans retélécharger (moins de réseau, moins de batterie).
// - Les données TCGdex (extensions, cartes) sont gardées 6 h : retour arrière et réouverture instantanés.
const IMG = "dex-img-v1", API = "dex-api-v1", MAX_IMG = 2500, API_TTL = 6 * 3600e3;
const IMG_HOSTS = /^(assets\.tcgdex\.net|images\.pokemontcg\.io|images\.scrydex\.com|limitlesstcg\.nyc3\.cdn\.digitaloceanspaces\.com|www\.google\.com|icons\.duckduckgo\.com)$/;
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (![IMG, API].includes(k)) await caches.delete(k);
  await self.clients.claim();
})()));

async function trim() {
  const c = await caches.open(IMG), keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_IMG; i++) await c.delete(keys[i]);
}
let trimT = null;
async function image(req) {
  const c = await caches.open(IMG), hit = await c.match(req.url);
  if (hit) return hit;
  try {
    // on redemande l'image en CORS pour pouvoir la garder ; si le site refuse, on la sert simplement sans la garder
    const r = await fetch(req.url, {mode: "cors", credentials: "omit"});
    if (r.ok && /image/.test(r.headers.get("content-type") || "")) {
      c.put(req.url, r.clone());
      clearTimeout(trimT); trimT = setTimeout(trim, 5000);
    }
    return r;
  } catch (e) { return fetch(req); }
}
async function api(req) {
  const c = await caches.open(API), hit = await c.match(req.url);
  const fresh = hit && Date.now() - Number(hit.headers.get("x-dex-t") || 0) < API_TTL;
  const net = fetch(req).then(async r => {
    if (r.ok) { const b = await r.clone().blob(); const h = new Headers(r.headers); h.set("x-dex-t", String(Date.now()));
      await c.put(req.url, new Response(b, {status: r.status, headers: h})); }
    return r;
  });
  if (fresh) { net.catch(() => {}); return hit; }     // récent : réponse immédiate, mise à jour en fond
  try { return await net; } catch (e) { if (hit) return hit; throw e; }
}
self.addEventListener("fetch", e => {
  const req = e.request; if (req.method !== "GET") return;
  let u; try { u = new URL(req.url); } catch (x) { return; }
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dex Scan</title>' +
      '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0911;color:#F1EAFF;font:16px system-ui;text-align:center;padding:24px">' +
      '<div><h1 style="font-size:22px">Pas de connexion</h1><p style="color:#9C90B3">Dex Scan a besoin d\'internet pour lire les cotes.<br>Reconnecte-toi puis touche « Réessayer ».</p>' +
      '<button onclick="location.reload()" style="margin-top:12px;padding:12px 18px;border:0;border-radius:12px;background:#9B5CFF;color:#fff;font:700 15px system-ui">Réessayer</button></div>',
      {headers: {"content-type": "text/html; charset=utf-8"}})));
    return;
  }
  if (req.destination === "image" && (IMG_HOSTS.test(u.hostname) || (u.origin === location.origin && u.pathname.includes("/media/")))) { e.respondWith(image(req)); return; }
  if (u.hostname === "api.tcgdex.net" && /\/v2\/\w+\/(sets|series|cards)\//.test(u.pathname)) { e.respondWith(api(req)); return; }
});
