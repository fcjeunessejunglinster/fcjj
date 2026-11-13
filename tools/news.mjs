// Fußball-News (Schlagzeilen) aus RSS-Feeds → data/news.json. Läuft im GitHub-Abruf, höchstens alle 50 Minuten.
// Die App zeigt nur Schlagzeile, Quelle und Zeit mit Link zum Artikel beim Anbieter (keine Artikeltexte).
// Feeds, die nicht antworten, werden übersprungen; ohne neue Daten bleibt der alte Stand.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = new URL("../data/news.json", import.meta.url);
export const FEEDS = {
  de: [
    { q: "kicker", url: "https://newsfeed.kicker.de/news/bundesliga" },
    { q: "kicker", url: "https://newsfeed.kicker.de/news/champions-league" },
    { q: "kicker", url: "https://newsfeed.kicker.de/news/europa-league" },
  ],
  en: [
    { q: "bundesliga.com", url: "https://www.bundesliga.com/rss/en/rss-news.rss" },
    { q: "BBC Sport", url: "https://feeds.bbci.co.uk/sport/football/european/rss.xml" },
    { q: "UEFA", url: "https://www.uefa.com/rss/uefachampionsleague/rss.xml" },
  ],
  fr: [
    { q: "L'Équipe", url: "https://dwh.lequipe.fr/api/edito/rss?path=/Football/" },
    { q: "UEFA", url: "https://fr.uefa.com/rss/uefachampionsleague/rss.xml" },
  ],
};
const PRO_SPRACHE = 12;

const entities = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, "")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();
const feld = (x, tag) => { const m = x.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i")); return m ? entities(m[1]) : ""; };
// RSS 2.0 (<item>) und Atom (<entry>)
export function lesen(xml, quelle) {
  const items = [...xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/gi)].map(m => m[0]);
  return items.map(x => {
    let link = feld(x, "link");
    if (!link) link = (x.match(/<link[^>]*href="([^"]+)"/i) || [])[1] || "";
    const d = Date.parse(feld(x, "pubDate") || feld(x, "updated") || feld(x, "published") || feld(x, "dc:date"));
    return { t: feld(x, "title"), u: link.trim(), d: isNaN(d) ? null : new Date(d).toISOString(), q: quelle };
  }).filter(n => n.t && /^https:\/\//.test(n.u));
}
async function holen(f) {
  const r = await fetch(f.url, { headers: { "user-agent": "Mozilla/5.0 (fcjj-app news; github.com/fcjeunessejunglinster/fcjj)" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(f.url + ": HTTP " + r.status);
  return lesen(await r.text(), f.q);
}
async function main() {
  const alt = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  if (alt && !process.env.NEWS_JETZT && Date.now() - Date.parse(alt.stand) < 50 * 60e3) { console.log("News: aktuell genug"); return; }
  const neu = { stand: new Date().toISOString() };
  for (const [l, feeds] of Object.entries(FEEDS)) {
    const alle = [];
    for (const f of feeds) {
      try { const n = await holen(f); alle.push(...n); console.log("News", l, f.q, n.length); }
      catch (e) { console.log("News", l, "übersprungen:", e.message); }
    }
    const gesehen = new Set();
    neu[l] = alle.filter(n => !gesehen.has(n.u) && gesehen.add(n.u)).sort((a, b) => (b.d || "").localeCompare(a.d || "")).slice(0, PRO_SPRACHE);
    if (!neu[l].length && alt?.[l]) neu[l] = alt[l];   // nichts bekommen → alten Stand behalten
  }
  writeFileSync(OUT, JSON.stringify(neu) + "\n");
}
if (import.meta.url === `file://${process.argv[1]}`) await main().catch(e => console.error("News:", e.message));
