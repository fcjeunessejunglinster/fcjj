// Fußball-News (nur Schlagzeilen mit Link zum Artikel) aus RSS-Feeds → data/news.json, je Sprache der App.
// Läuft im GitHub-Abruf, weil die Feeds den Abruf direkt aus dem Browser nicht erlauben. Fehler stören den Abruf nicht.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const OUT = new URL("../data/news.json", import.meta.url);
const FEEDS = {
  de: [["kicker", "https://newsfeed.kicker.de/news/bundesliga"], ["kicker", "https://newsfeed.kicker.de/news/champions-league"],
    ["kicker", "https://newsfeed.kicker.de/news/europa-league"]],
  en: [["BBC Sport", "https://feeds.bbci.co.uk/sport/football/european/rss.xml"], ["bundesliga.com", "https://www.bundesliga.com/rss/en/rss-news.rss"]],
  fr: [["RMC Sport", "https://rmcsport.bfmtv.com/rss/football/"]],
};
const PRO_SPRACHE = 12;

const ent = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const feld = (item, tag) => { const m = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)); return m ? ent(m[1]) : ""; };

export function lesen(xml, quelle) {
  return [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)].map(([it]) => {
    const t = feld(it, "title"), u = feld(it, "link") || feld(it, "guid"), d = Date.parse(feld(it, "pubDate") || feld(it, "dc:date"));
    return t && /^https:\/\//.test(u) ? { t: t.slice(0, 200), u, d: isNaN(d) ? null : new Date(d).toISOString(), q: quelle } : null;
  }).filter(Boolean);
}
async function holen(url) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (fcjj-app; github.com/fcjeunessejunglinster/fcjj)" }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(url + ": HTTP " + r.status);
  return r.text();
}
async function main() {
  const aus = { stand: new Date().toISOString() };
  for (const [l, feeds] of Object.entries(FEEDS)) {
    const alle = [], gesehen = new Set();
    for (const [q, url] of feeds) {
      try { for (const n of lesen(await holen(url), q)) if (!gesehen.has(n.u)) { gesehen.add(n.u); alle.push(n); } }
      catch (e) { console.error("News:", e.message); }
    }
    aus[l] = alle.sort((a, b) => (b.d || "").localeCompare(a.d || "")).slice(0, PRO_SPRACHE);
  }
  if (!["de", "en", "fr"].some(l => aus[l].length)) { console.error("News: nichts geladen, alter Stand bleibt"); return; }
  // nur schreiben, wenn sich Schlagzeilen geändert haben (sonst gäbe es bei jedem Abruf eine Änderung)
  const alt = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  if (["de", "en", "fr"].every(l => JSON.stringify(alt[l]) === JSON.stringify(aus[l]))) { console.log("News: unverändert"); return; }
  writeFileSync(OUT, JSON.stringify(aus) + "\n");
  console.log("News:", ["de", "en", "fr"].map(l => `${l} ${aus[l].length}`).join(", "));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
