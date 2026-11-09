// Test mit nachgebauten Rohdaten: echte FLF-Spiele, in denen der FCJJ vorkommt.
// node test/abruf.mjs <pfad zu fussball.json mit FLF-Daten> [ausgabe]
import { readFileSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { aufbereiten, katAusNamen, eigeneSpiele, ics, dateiName, bamDazu, KATS } from "../tools/abruf.mjs";

// katAusNamen
assert.equal(katAusNamen(["U13 Minimes Cl3 S2 Phase 2"]), "U13");
assert.equal(katAusNamen(["WU13 Cl1"]), "WU13");
assert.equal(katAusNamen(["U17 Cadets Cl2"]), "U17");
assert.equal(katAusNamen(["Juniors U19 Promotion"]), "U19");
assert.equal(katAusNamen(["Dames Cl1"]), null);
assert.equal(katAusNamen(["Coupe U15 Scolaires - 1/32"]), "U15");

const src = JSON.parse(readFileSync(process.argv[2], "utf8"));
const CLUB = 999;
const roh = t => ({ id: t.id, name: t.n, clubId1: t.n.startsWith("Jeunesse Junglinster") ? CLUB : 1, clubId2: null, clubId3: null, clubId4: null });
const vereinsSpiele = [], klassen = {};
for (const k of Object.values(src.klassen)) {
  if (String(k.id).match(/^(bam|coach)/)) continue;
  const kat = katAusNamen([k.n]) || (/Réserves/.test(k.n) ? "RES" : "SEN");
  const r = k.spiele.map(sp => ({ match: { id: sp.id, gameday: sp.tag, matchDate: sp.d, isPlayed: sp.gespielt, isForfait: sp.forfait,
      homeScore: sp.hs, awayScore: sp.as, finalHomeScore: null, finalAwayScore: null, finalScoreComment: null },
    division: { id: k.id, name: k.n, showResult: k.ergebnisse, showRanking: !!k.tabelle }, matchType: { id: k.typ },
    homeTeam: roh(sp.h), awayTeam: roh(sp.a), sportField: sp.ort ? { name: sp.ort } : null }));
  const unsere = r.filter(m => m.homeTeam.clubId1 === CLUB || m.awayTeam.clubId1 === CLUB);
  if (!unsere.length) continue;
  vereinsSpiele.push(...unsere.map(m => ({ ...m, kat })));
  klassen[k.id] = { spiele: r, tabelle: k.tabelle?.map(z => ({ ranking: { rank: z.pl, teamId: z.id, totalPlays: z.sp, totalWins: z.s, totalDraws: z.u,
    totalLosses: z.nl, totalOwnGoals: z.t, totalAgainstGoals: z.g, totalPoints: z.pkt }, team: { id: z.id, name: z.n } })) || null };
}
const D = aufbereiten({ saison: src.saison, club: CLUB, vereinsSpiele, klassen });
// Bambinis nachgebaut
const bk = Object.values(src.klassen).filter(k => String(k.id).startsWith("bam-"));
const bam = { teams: [{ id: 9000702, ids: [9000702], n: "Jeunesse Junglinster II", kat: "U7", nr: 2, klassen: bk.map(k => k.id) }], klassen: {} };
for (const k of bk) bam.klassen[k.id] = { ...k, spiele: k.spiele.filter(sp => sp.bam?.mit.some(n => /Junglinster/.test(n))).map(sp => {
  const heim = /Junglinster/.test(sp.ort || ""); const wir = { id: 9000702, n: "Jeunesse Junglinster II" };
  const tur = { id: 0, n: "Mini-Spieltag mit " + sp.bam.mit.filter(n => !/Junglinster/.test(n)).concat("FC Koeppchen Wormeldange I").join(", ") };
  return { ...sp, h: heim ? wir : tur, a: heim ? tur : wir }; }) };
bamDazu(D, bam);
for (const t of D.teams) t.datei = dateiName(t);

console.log(D.teams.map(t => `${t.reiter} (${t.n}) ${eigeneSpiele(D, t).length} Spiele, mit ${t.mit.length}`).join("\n"));
const reihe = D.teams.map(t => KATS.findIndex(k => k.key === t.kat));
assert.deepEqual(reihe, [...reihe].sort((a, b) => a - b), "Reihenfolge der Reiter");
assert.ok(D.teams.every(t => t.reiter && t.datei.endsWith(".ics")));
for (const t of D.teams) { const c = ics(D, t); assert.ok(c.startsWith("BEGIN:VCALENDAR") && c.includes("END:VCALENDAR")); }
// keine Ergebnisse bei U9/U11
for (const t of D.teams.filter(t => ["U9", "U11"].includes(t.kat))) assert.ok(eigeneSpiele(D, t).every(sp => !sp.erg));
D.kategorien = { tag: "test", ids: {} };
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(D));
console.log("alle Tests ok");
