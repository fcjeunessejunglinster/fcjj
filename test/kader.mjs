// Prüft tools/kader.mjs mit gespeicherten Antworten von API-Football (Bayern München, Saison 2026).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { kaderHolen, profileHolen, profil } from "../tools/kader.mjs";
const lies = f => JSON.parse(readFileSync(new URL("kader-daten/" + f + ".json", import.meta.url)));
process.env.KADER_PAUSE = "0";
let n = 0;
globalThis.fetch = async u => { n++;
  const b = u.includes("teams?") ? lies("teams") : u.includes("squads") ? lies("kader157") : u.includes("page=2") ? lies("spieler2") : lies("spieler1");
  return new Response(JSON.stringify(b)); };
const teams = await kaderHolen(2026);
assert.equal(teams.length, 18);
await profileHolen(teams, 2026);
const bayern = teams.find(t => t.n === "Bayern München"), neuer = bayern.sp.find(s => s.id === 497);
console.log(neuer);
assert.equal(neuer.p.vn, "Manuel Peter");
assert.equal(neuer.p.gr, 193);
assert.equal(neuer.p.bl.sp, 5);          // nur Bundesliga, nicht Champions League
assert.equal(neuer.p.bl.note, 7);
console.log("Anfragen:", n, "· mit Profil:", bayern.sp.filter(s => s.p).length, "von", bayern.sp.length);
// Note „0“ (kein Einsatz) → keine Note
assert.equal(profil({ player: { id: 1 }, statistics: [{ league: { id: 78 }, team: { id: 5 }, games: { rating: "0" }, goals: {}, cards: {} }] }, 5).bl.note, null);
console.log("Kader-Test ok");
