// Vereinslogos von der FLF → logos/<Vereinsnummer>.<svg|png|jpg> und data/logos.json ({nummer: datei|null}).
// Quelle: https://extranet.flf.lu/api/export/clublogo/<Vereinsnummer> (dieselbe Adresse nutzt das FLF-Extranet).
// Läuft im GitHub-Abruf nach tools/abruf.mjs. Neue Vereine sofort, bekannte höchstens alle 14 Tage neu
// (pro Lauf höchstens 40 Abrufe). Ohne Logo liefert die FLF einen grauen Kreis: das gilt als „kein Logo“ (null).
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";

const BASIS = "https://extranet.flf.lu/api/export/clublogo/";
const DATEN = new URL("../data/fussball.json", import.meta.url);
const OUT = new URL("../data/logos.json", import.meta.url);
const DIR = new URL("../logos/", import.meta.url);
const ALT = 14 * 864e5, MAX = 40;
const ENDUNG = { "image/svg+xml": "svg", "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

export const platzhalter = (typ, buf) => typ === "image/svg+xml" && buf.length < 2000 && /stroke="#828282"/.test(buf.toString("utf8"));
export function vereine(d) {
  const ids = new Set(d.verein?.id ? [d.verein.id] : []);
  for (const k of Object.values(d.klassen || {})) for (const sp of k.spiele || []) for (const t of [sp.h, sp.a]) if (t?.c) ids.add(t.c);
  return [...ids];
}

async function main() {
  const d = JSON.parse(readFileSync(DATEN, "utf8"));
  const alt = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { logos: {}, geholt: {} };
  const neu = { logos: { ...alt.logos }, geholt: { ...alt.geholt } };
  mkdirSync(DIR, { recursive: true });
  const jetzt = Date.now();
  const offen = vereine(d).filter(id => !(id in neu.logos) || jetzt - (neu.geholt[id] || 0) > ALT)
    .sort((a, b) => (a in neu.logos) - (b in neu.logos) || (neu.geholt[a] || 0) - (neu.geholt[b] || 0)).slice(0, MAX);
  let n = 0;
  for (const id of offen) {
    try {
      const r = await fetch(BASIS + id, { signal: AbortSignal.timeout(15000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const typ = (r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const buf = Buffer.from(await r.arrayBuffer());
      const vorher = neu.logos[id];
      if (!ENDUNG[typ] || platzhalter(typ, buf) || buf.length > 400000) neu.logos[id] = null;
      else {
        const datei = `${id}.${ENDUNG[typ]}`;
        const pfad = new URL(datei, DIR);
        if (!existsSync(pfad) || !readFileSync(pfad).equals(buf)) writeFileSync(pfad, buf);
        neu.logos[id] = datei;
      }
      if (vorher && vorher !== neu.logos[id] && existsSync(new URL(vorher, DIR))) unlinkSync(new URL(vorher, DIR));
      neu.geholt[id] = jetzt; n++;
    } catch (e) { console.log("Logo", id, e.message); }
    await new Promise(r => setTimeout(r, 250));
  }
  const aenderung = JSON.stringify(neu.logos) !== JSON.stringify(alt.logos);
  if (n) writeFileSync(OUT, JSON.stringify(neu) + "\n");
  console.log(`Logos: ${n} geprüft, ${Object.values(neu.logos).filter(Boolean).length} vorhanden, ${aenderung ? "geändert" : "unverändert"}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main();
