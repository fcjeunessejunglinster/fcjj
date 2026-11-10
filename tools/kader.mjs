// Kader und Spielerprofile der 1. Bundesliga und der Luxemburger Nationalmannschaft von API-Football (v3.football.api-sports.io) → data/bl-kader.json.
// Läuft im GitHub-Abruf; der Schlüssel steht nur als Secret APIFOOTBALL_KEY in GitHub (nie in der App).
//  - Kader (Mannschaften + 18 Kader, 19 Anfragen): höchstens alle 6 Tage, ändern sich selten.
//  - Profile mit Saisonstatistik (/players, 20 Spieler je Seite, etwa 40 Anfragen): höchstens einmal am Tag.
// Bei Fehlern (kein Schlüssel, Tageslimit, Saison im Plan nicht enthalten) bleibt der alte Stand.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OUT = new URL("../data/bl-kader.json", import.meta.url);
const KEY = process.env.APIFOOTBALL_KEY;
const LIGA = 78;   // 1. Bundesliga bei API-Football
const KADER_TAGE = 6, PROFIL_STUNDEN = 20;
const pause = ms => new Promise(r => setTimeout(r, ms));

async function api(pfad) {
  await pause(Number(process.env.KADER_PAUSE ?? 250));
  const r = await fetch("https://v3.football.api-sports.io/" + pfad, { headers: { "x-apisports-key": KEY } });
  if (!r.ok) throw new Error(pfad + ": HTTP " + r.status);
  const j = await r.json();
  const fehler = Array.isArray(j.errors) ? j.errors : Object.values(j.errors || {});
  if (fehler.length) throw new Error(pfad + ": " + JSON.stringify(j.errors));
  return j;
}
const zahl = x => (x === null || x === undefined || x === "") ? null : Number(x);
const cm = x => zahl(String(x ?? "").replace(/\D/g, "")) || null;

export async function kaderHolen(saison) {
  const teams = (await api(`teams?league=${LIGA}&season=${saison}`)).response;
  const aus = [];
  for (const { team } of teams) {
    const k = (await api(`players/squads?team=${team.id}`)).response[0];
    aus.push({ id: team.id, n: team.name, logo: team.logo,
      sp: (k?.players || []).map(p => ({ id: p.id, n: p.name, nr: p.number ?? null, pos: p.position, a: p.age ?? null, f: p.photo })) });
  }
  if (aus.length < 10 || aus.filter(t => t.sp.length).length < 10) throw new Error("zu wenige Kader (" + aus.length + ")");
  return aus.sort((a, b) => a.n.localeCompare(b.n, "de"));
}
// Statistik eines Wettbewerbs (ein Eintrag aus statistics[]) in kurzer Form.
const werte = st => ({ sp: zahl(st.games?.appearences) || 0, se: zahl(st.games?.lineups) || 0, min: zahl(st.games?.minutes) || 0,
  t: zahl(st.goals?.total) || 0, v: zahl(st.goals?.assists) || 0, gk: zahl(st.goals?.conceded), par: zahl(st.goals?.saves),
  g: zahl(st.cards?.yellow) || 0, r: (zahl(st.cards?.red) || 0) + (zahl(st.cards?.yellowred) || 0),
  note: Number(st.games?.rating) > 0 ? Math.round(Number(st.games.rating) * 10) / 10 : null });
const person = p => ({ vn: p.firstname || null, nn: p.lastname || null, geb: p.birth?.date || null, ort: p.birth?.place || null,
  gland: p.birth?.country || null, nat: p.nationality || null, gr: cm(p.height), gw: cm(p.weight), verl: !!p.injured });
// Profil eines Spielers aus /players: Person + Statistik dieser Saison in der Bundesliga (bei diesem Verein).
export function profil(x, teamId) {
  const st = (x.statistics || []).find(s => s.league?.id === LIGA && s.team?.id === teamId)
    || (x.statistics || []).find(s => s.league?.id === LIGA);
  return { ...person(x.player), bl: st ? werte(st) : null };
}
// Nationalspieler: Statistik je Wettbewerb (Nations League, Freundschaftsspiele …) für die Nationalmannschaft.
export const natiProfil = (x, teamId) => ({ ...person(x.player),
  wb: (x.statistics || []).filter(s => s.team?.id === teamId && zahl(s.games?.appearences)).map(s => ({ n: s.league?.name || "", ...werte(s) })) });

// ---- Luxemburgs Nationalmannschaft → data/nati-af.json: Kader mit Profilen und Gruppentabelle (Nations League),
// etwa 5 Anfragen, höchstens einmal am Tag.
const NATI = 1102, NATI_OUT = new URL("../data/nati-af.json", import.meta.url), NL = 5;
export async function natiHolen() {
  const saison = (await api(`leagues?id=${NL}&current=true`)).response[0]?.seasons?.find(s => s.current)?.year;
  const kader = (await api(`players/squads?team=${NATI}`)).response[0]?.players || [];
  if (kader.length < 11) throw new Error("Kader der Nationalmannschaft fehlt");
  const prof = new Map();
  for (let seite = 1, gesamt = 1; seite <= gesamt && seite <= 5; seite++) {
    const j = await api(`players?team=${NATI}&season=${saison}&page=${seite}`);
    gesamt = j.paging?.total || 1;
    for (const x of j.response || []) prof.set(x.player.id, natiProfil(x, NATI));
  }
  let tabelle = null;
  try {
    const grp = (await api(`standings?league=${NL}&season=${saison}`)).response[0]?.league?.standings
      ?.find(g => g.some(r => r.team?.id === NATI));
    if (grp) tabelle = { gruppe: grp[0].group, zeilen: grp.map(r => ({ id: r.team.id, n: r.team.name, logo: r.team.logo, rang: r.rank,
      sp: r.all.played, s: r.all.win, u: r.all.draw, n2: r.all.lose, tore: r.all.goals.for, gegen: r.all.goals.against, pkt: r.points })) };
  } catch (e) { console.error("Nati-Tabelle:", e.message); }
  return { stand: new Date().toISOString(), saison,
    sp: kader.map(p => ({ id: p.id, n: p.name, nr: p.number ?? null, pos: p.position, a: p.age ?? null, f: p.photo, p: prof.get(p.id) || null })),
    tabelle };
}
async function natiMain() {
  const alt = existsSync(NATI_OUT) ? JSON.parse(readFileSync(NATI_OUT, "utf8")) : null;
  if (alt && !process.env.KADER_JETZT && Date.now() - Date.parse(alt.stand) < PROFIL_STUNDEN * 3600e3) { console.log("Nati: aktuell genug"); return; }
  const neu = await natiHolen();
  writeFileSync(NATI_OUT, JSON.stringify(neu) + "\n");
  console.log("Nati:", neu.sp.length, "Spieler,", neu.sp.filter(s => s.p).length, "mit Profil, Tabelle", neu.tabelle?.gruppe || "–");
}
export async function profileHolen(teams, saison) {
  for (const t of teams) {
    const prof = new Map();
    for (let seite = 1, gesamt = 1; seite <= gesamt && seite <= 5; seite++) {
      const j = await api(`players?team=${t.id}&season=${saison}&page=${seite}`);
      gesamt = j.paging?.total || 1;
      for (const x of j.response || []) prof.set(x.player.id, profil(x, t.id));
    }
    for (const s of t.sp) { const p = prof.get(s.id); if (p) s.p = p; }
  }
}

async function main() {
  if (!KEY) { console.log("Kader: kein Schlüssel (APIFOOTBALL_KEY), übersprungen"); return; }
  const alt = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  const jetzt = Date.now(), jetztKader = process.env.KADER_JETZT;
  const kaderAlt = !alt?.teams?.[0]?.sp?.[0]?.id || jetztKader || jetzt - Date.parse(alt.stand) > KADER_TAGE * 864e5;
  const profilAlt = kaderAlt || !alt.profile || jetzt - Date.parse(alt.profile) > PROFIL_STUNDEN * 3600e3;
  if (!profilAlt) { console.log("Kader und Profile: aktuell genug"); return; }
  const liga = (await api(`leagues?id=${LIGA}&current=true`)).response[0];
  const saison = liga?.seasons?.find(s => s.current)?.year;
  if (!saison) throw new Error("keine laufende Saison");
  const neu = kaderAlt ? { stand: new Date().toISOString(), saison, teams: await kaderHolen(saison) } : { ...alt, saison };
  try { await profileHolen(neu.teams, saison); neu.profile = new Date().toISOString(); }
  catch (e) { console.error("Profile nicht aktualisiert:", e.message); if (!kaderAlt) return; }
  writeFileSync(OUT, JSON.stringify(neu) + "\n");
  const n = neu.teams.reduce((s, t) => s + t.sp.length, 0), mitP = neu.teams.reduce((s, t) => s + t.sp.filter(x => x.p).length, 0);
  console.log("Kader:", neu.teams.length, "Mannschaften,", n, "Spieler,", mitP, "mit Profil, Saison", saison);
}
if (import.meta.url === `file://${process.argv[1]}`) {
  await main().catch(e => { console.error("Kader nicht aktualisiert:", e.message); });
  if (KEY) await natiMain().catch(e => { console.error("Nati nicht aktualisiert:", e.message); });
}
