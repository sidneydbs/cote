// Construit cards-index.json : empreinte visuelle (pHash carte entière + illustration) de chaque carte TCGdex.
// Le calcul tourne dans Chrome avec exactement le même code que l'app (tools/cardsig.js).
import puppeteer from "puppeteer-core";
import fs from "fs";

const API = process.env.CARDS_API || "https://api.tcgdex.net/v2/en/cards";
const sigSrc = fs.readFileSync(new URL("./cardsig.js", import.meta.url), "utf8");
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || "/usr/bin/google-chrome",
  args: ["--no-sandbox"], protocolTimeout: 0,
});
const page = await browser.newPage();
await page.setContent("<!doctype html><title>index</title>");
page.on("console", m => console.log(m.text()));
const out = await page.evaluate(async (sigSrc, API) => {
  const S = new Function(sigSrc + "\nreturn CARDSIG;")();
  const list = await (await fetch(API)).json();
  const pocket = id => /^(P-A|[AB]\d+[a-z]?)-/.test(id);
  const cards = list.filter(c => c.image && !pocket(c.id));
  const res = []; let i = 0, fail = 0, done = 0;
  await Promise.all(Array.from({length: 8}, async () => {
    while (i < cards.length) {
      const c = cards[i++];
      for (let t = 0; t < 5; t++) {
        try {
          const r = await fetch(c.image + "/low.webp");
          if (!r.ok) throw new Error("HTTP " + r.status);
          const bm = await createImageBitmap(await r.blob());
          const s = S.sig(bm, 0, 0, bm.width, bm.height);
          const parts = c.image.split("/");
          res.push([c.id, c.name, parts[parts.length - 3], S.hex(s.art) + S.hex(s.full)]);
          break;
        } catch (e) { if (t === 4) fail++; else await new Promise(r => setTimeout(r, 1500 * (t + 1))); }
      }
      if (++done % 1000 === 0) console.log(`${done} / ${cards.length}`);
    }
  }));
  return {res, fail, total: cards.length};
}, sigSrc, API);
await browser.close();

const series = {}, rows = [];
for (const [id, name, serie, h] of out.res.sort((a, b) => a[0].localeCompare(b[0]))) {
  const set = id.slice(0, id.lastIndexOf("-"));
  series[set] = serie;
  rows.push([id, name, h]);
}
const index = {v: 1, built: new Date().toISOString(), source: "tcgdex en", series, cards: rows};
fs.writeFileSync("cards-index.json", JSON.stringify(index));
console.log(`index : ${rows.length} cartes sur ${out.total}, ${out.fail} échecs`);
if (rows.length < out.total * 0.9) { console.error("Trop d'échecs, index non publié"); process.exit(1); }
