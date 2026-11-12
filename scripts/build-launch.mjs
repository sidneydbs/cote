// Images de démarrage iPhone : l'écran qu'iOS affiche pendant le lancement de l'app installée sur l'écran d'accueil.
// Sans elles, iOS montre un écran noir avant l'intro. On rend la Poké Ball de l'intro (même code que index.html)
// pour chaque taille d'écran d'iPhone. Sortie : media/launch/launch-<largeur>x<hauteur>.jpg
import fs from "node:fs";
import {chromium} from "playwright";

const s = fs.readFileSync("index.html", "utf8");
const head = s.slice(0, s.indexOf("</head>"));
const styles = (head.match(/<style>[\s\S]*?<\/style>/g) || []).join("");
const svg = s.slice(s.indexOf("<body>") + 6, s.indexOf("<script>window.__APPV"));
const sp = s.match(/<div class="splash" id="splash"[\s\S]*?<i class="glow"><\/i><\/div>/)[0];
const page = `<!doctype html><html lang="fr" data-theme="spectre"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}<style>*,*::before,*::after{animation:none!important;transition:none!important}</style></head><body>${svg}${sp}</body></html>`;

// [largeur, hauteur, densité] en points iOS, écran en portrait
const sizes = [[440,956,3],[430,932,3],[402,874,3],[393,852,3],[428,926,3],[390,844,3],[375,812,3],[414,896,3],[414,896,2],[375,667,2]];
fs.mkdirSync("media/launch", {recursive: true});
const b = await chromium.launch();
for (const [w, h, r] of sizes) {
  const p = await b.newPage({viewport: {width: w, height: h}, deviceScaleFactor: r});
  await p.route(/^https?:/, rt => rt.abort());
  await p.setContent(page);
  await p.waitForTimeout(200);
  await p.screenshot({path: `media/launch/launch-${w * r}x${h * r}.jpg`, type: "jpeg", quality: 82});
  await p.close();
  console.log("launch", w * r, "x", h * r);
}
await b.close();
