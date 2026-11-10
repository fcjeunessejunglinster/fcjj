// Kader der 1. Bundesliga von API-Football (v3.football.api-sports.io) → data/bl-kader.json.
// Läuft im GitHub-Abruf; der Schlüssel steht nur als Secret APIFOOTBALL_KEY in GitHub (nie in der App).
// Kader ändern sich selten: höchstens alle 6 Tage neu holen (19 Anfragen: Mannschaften + 18 Kader).
// Bei Fehlern (kein Schlüssel, Tageslimit, Saison im Plan nicht enthalten) bleibt der alte Stand.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = new URL("../data/bl-kader.json", import.meta.url);
const KEY = process.env.APIFOOTBALL_KEY;
const LIGA = 78;   // 1. Bundesliga bei API-Football
const ALLE_TAGE = 6;

async function api(pfad) {
  const r = await fetch("https://v3.football.api-sports.io/" + pfad, { headers: { "x-apisports-key": KEY } });
  if (!r.ok) throw new Error(pfad + ": HTTP " + r.status);
  const j = await r.json();
  const fehler = Array.isArray(j.errors) ? j.errors : Object.values(j.errors || {});
  if (fehler.length) throw new Error(pfad + ": " + JSON.stringify(j.errors));
  return j.response;
}

async function main() {
  if (!KEY) { console.log("Kader: kein Schlüssel (APIFOOTBALL_KEY), übersprungen"); return; }
  const alt = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  if (alt && !process.env.KADER_JETZT && Date.now() - Date.parse(alt.stand) < ALLE_TAGE * 864e5) { console.log("Kader: aktuell genug"); return; }
  const liga = (await api(`leagues?id=${LIGA}&current=true`))[0];
  const saison = liga?.seasons?.find(s => s.current)?.year;
  if (!saison) throw new Error("keine laufende Saison");
  const teams = await api(`teams?league=${LIGA}&season=${saison}`);
  const aus = [];
  for (const { team } of teams) {
    const k = (await api(`players/squads?team=${team.id}`))[0];
    aus.push({ id: team.id, n: team.name, logo: team.logo,
      sp: (k?.players || []).map(p => ({ n: p.name, nr: p.number ?? null, pos: p.position, a: p.age ?? null, f: p.photo })) });
  }
  if (aus.length < 10 || aus.filter(t => t.sp.length).length < 10) throw new Error("zu wenige Kader (" + aus.length + ")");
  aus.sort((a, b) => a.n.localeCompare(b.n, "de"));
  writeFileSync(OUT, JSON.stringify({ stand: new Date().toISOString(), saison, teams: aus }) + "\n");
  console.log("Kader:", aus.length, "Mannschaften,", aus.reduce((s, t) => s + t.sp.length, 0), "Spieler, Saison", saison);
}
main().catch(e => { console.error("Kader nicht aktualisiert:", e.message); });
