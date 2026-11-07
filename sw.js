// Dex Scan : service worker minimal pour l'installation (Android).
// Il ne met rien en cache : l'app est toujours chargée à jour depuis le réseau.
// Sans réseau, il affiche une petite page d'attente au lieu d'une erreur.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dex Scan</title>' +
    '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0B0911;color:#F1EAFF;font:16px system-ui;text-align:center;padding:24px">' +
    '<div><h1 style="font-size:22px">Pas de connexion</h1><p style="color:#9C90B3">Dex Scan a besoin d\'internet pour lire les cotes.<br>Reconnecte-toi puis touche « Réessayer ».</p>' +
    '<button onclick="location.reload()" style="margin-top:12px;padding:12px 18px;border:0;border-radius:12px;background:#9B5CFF;color:#fff;font:700 15px system-ui">Réessayer</button></div>',
    {headers: {"content-type": "text/html; charset=utf-8"}})));
});
