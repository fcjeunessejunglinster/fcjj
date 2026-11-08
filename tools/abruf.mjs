// Abruf FLF → data/fussball.json für die App (index.html) und kalender/*.ics.
// Läuft als GitHub Action (.github/workflows/abruf.yml), lokal: node tools/abruf.mjs
//
// Quelle: die Schnittstelle hinter https://extranet.flf.lu/match (antwortet ohne Anmeldung, aber ohne
// CORS-Freigabe — darum dieser Umweg über GitHub). Idee und Schnittstelle übernommen aus
// fckoeppchen.github.io, für den FC Jeunesse Junglinster neu und schlanker geschrieben.
//
// Der Verein und die Altersklassen werden selbst gesucht: Die FLF-Nummer des Vereins kommt über
// eine bekannte Mannschaft, die Altersklassen über einen Durchlauf aller Nummern (einmal am Tag).
// Gefundenes steht in data/fussball.json (`verein`, `kategorien`).

import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";

export const API = "https://extranet.flf.lu/api/graphql";
export const VEREIN = "Jeunesse Junglinster";
// Eine Mannschaft des Vereins (Seniors 2026-27), nur um die Vereinsnummer zu finden.
const BEKANNTE_MANNSCHAFT = 44720;

// Reiter in dieser Reihenfolge (vom Verein). `id` = ageCategoryId der FLF, wo bekannt; die
// anderen findet der Durchlauf über die Namen der Klassen (`muster`).
export const KATS = [
  { key: "U7",   n: "Bambinis U7",     kurz: "BAM" },
  { key: "U9",   n: "Pupilles U9",     kurz: "PUP",  id: 5,  muster: /\bU\s?9\b|Pupilles/i },
  { key: "U11",  n: "Poussins U11",    kurz: "POU",  id: 7,  muster: /\bU\s?11\b|Poussins/i },
  { key: "U13",  n: "Minimes U13",     kurz: "MIN",  id: 4,  muster: /\bU\s?13\b|Minimes/i },
  { key: "U15",  n: "Scolaires U15",   kurz: "SCO",  id: 11, muster: /\bU\s?15\b|Scolaires/i },
  { key: "U17",  n: "Cadets U17",      kurz: "CAD",  muster: /\bU\s?17\b|\bCadets\b/i },
  { key: "U19",  n: "Juniors U19",     kurz: "JUN",  muster: /\bU\s?19\b|\bJuniors\b/i },
  { key: "WU11", n: "Fillettes WU11",  kurz: "WU11", muster: /\bWU\s?11\b|Fillettes/i },
  { key: "WU13", n: "Filles WU13",     kurz: "WU13", muster: /\bWU\s?13\b/i },
  { key: "WU15", n: "Jeunes Filles WU15", kurz: "WU15", muster: /\bWU\s?15\b|Jeunes Filles/i },
  { key: "SEN",  n: "Seniors",         kurz: "Seniors",  id: 1 },
  { key: "RES",  n: "Seniors Réserves", kurz: "Réserves", id: 9999 },
  // Altersklasse 28: bei der FLF nur Freundschaftsspiele („Amicaux 2“), montags 19:30 — die Veteranen (vom Verein, 8.11.2026).
  { key: "VET",  n: "Veteranen",       kurz: "Veteranen", id: 28 },
];
// Bei den Kleinen zeigt die App keine Ergebnisse (wie die FLF; auch nicht in Freundschaftsspielen).
export const KEINE_ERG = ["U7", "U9", "U11", "WU11"];

const OUT = new URL("../data/fussball.json", import.meta.url);
const KAL = new URL("../kalender/", import.meta.url);

const M_FIELDS = `match{ id gameday matchDate isPlayed isForfait homeScore awayScore finalHomeScore finalAwayScore finalScoreComment }
  division{ id name showResult showRanking } matchType{ id }
  homeTeam{ id name clubId1 clubId2 clubId3 clubId4 } awayTeam{ id name clubId1 clubId2 clubId3 clubId4 }
  sportField{ name }`;
const Q_DEFAULTS = `{ defaultValues{ currentSeasonId } seasons{ id name startDate endDate } }`;
const Q_MATCHES = `query($c: MatchCriteria){ matches(criteria:$c){ ${M_FIELDS} } }`;
const Q_RANKING = `query($c: MatchCriteria){ rankings(criteria:$c){
  ranking{ rank teamId totalPlays totalWins totalDraws totalLosses totalOwnGoals totalAgainstGoals totalPoints } team{ id name } } }`;

const pause = ms => new Promise(r => setTimeout(r, ms));
async function gq(query, variables = {}) {
  for (let versuch = 1; ; versuch++) {
    try {
      const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const j = await r.json();
      if (j.errors?.length) throw new Error(j.errors.map(e => e.message).join("; "));
      return j.data;
    } catch (e) {
      if (versuch >= 3) throw e;
      await pause(5000 * versuch);
    }
  }
}

const day = iso => iso.slice(0, 10);
const vereinsIds = t => [t.clubId1, t.clubId2, t.clubId3, t.clubId4].filter(Boolean);

// ---- Altersklasse aus den Namen der Klassen ----
// Gibt den `key` aus KATS zurück oder null. Frauen zuerst prüfen („WU13“ enthält „U13“).
export function katAusNamen(namen) {
  const text = namen.join(" | ");
  for (const k of KATS.filter(k => k.key.startsWith("W") && k.muster)) if (k.muster.test(text)) return k.key;
  if (/\bDames\b|Féminin|\bWU\s?\d/i.test(text)) return null;          // andere Frauen-Klassen: nicht gewünscht
  for (const k of KATS.filter(k => !k.key.startsWith("W") && k.muster)) if (k.muster.test(text)) return k.key;
  return null;
}

// ---- Ein Spiel der Schnittstelle → schlankes Format ----
export function bemerkung(t) {
  if (!t) return undefined;
  if (/^arr.t.$/i.test(t.trim())) return "Arrêté";
  return t.replace(/\uFFFD/g, "?");
}
export function spiel(m) {
  const x = m.match, final = x.finalHomeScore != null;
  const ohne = m.division?.showResult === false;
  return {
    id: x.id, d: x.matchDate, tag: x.gameday,
    h: { id: m.homeTeam.id, n: m.homeTeam.name },
    a: { id: m.awayTeam.id, n: m.awayTeam.name },
    hs: ohne ? null : final ? x.finalHomeScore : x.homeScore,
    as: ohne ? null : final ? x.finalAwayScore : x.awayScore,
    gespielt: !!x.isPlayed || (final && !x.isForfait),
    forfait: !!x.isForfait,
    bem: bemerkung(x.finalScoreComment),
    ort: m.sportField?.name || undefined,
  };
}
export const tabelle = rankings => rankings.map(r => ({
  pl: r.ranking.rank, id: r.team.id, n: r.team.name, sp: r.ranking.totalPlays, s: r.ranking.totalWins,
  u: r.ranking.totalDraws, nl: r.ranking.totalLosses, t: r.ranking.totalOwnGoals, g: r.ranking.totalAgainstGoals, pkt: r.ranking.totalPoints,
})).sort((a, b) => a.pl - b.pl);

// ---- Aufbereiten ----
// vereinsSpiele: Rohdaten mit `kat` (key aus KATS). klassen: {divisionId: {spiele: roh[], tabelle: roh[]|null}}.
// Eine Mannschaft = Altersklasse + Name (die FLF vergibt nach der Winterpause neue Nummern).
const ROEM = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
export const zusatz = n => n.replace(VEREIN, "").trim();
export function aufbereiten({ saison, club, vereinsSpiele, klassen }) {
  const istVerein = t => t && vereinsIds(t).includes(club);
  const teams = new Map(), nachId = new Map();
  for (const m of [...vereinsSpiele].sort((a, b) => a.match.matchDate.localeCompare(b.match.matchDate)))
    for (const t of [m.homeTeam, m.awayTeam]) {
      if (!istVerein(t) || nachId.has(t.id)) continue;
      const k = m.kat + "|" + t.name;
      if (!teams.has(k)) teams.set(k, { id: t.id, ids: [], n: t.name, kat: m.kat, klassen: [] });
      teams.get(k).ids.push(t.id);
      nachId.set(t.id, teams.get(k));
    }
  const div = {};
  for (const m of vereinsSpiele) {
    const k = m.division;
    div[k.id] ??= { id: k.id, n: k.name, typ: m.matchType?.id || "", ergebnisse: k.showResult !== false, tabelle: null, spiele: [], start: m.match.matchDate };
    if (m.match.matchDate < div[k.id].start) div[k.id].start = m.match.matchDate;
    for (const t of [m.homeTeam, m.awayTeam])
      if (istVerein(t) && !nachId.get(t.id).klassen.includes(k.id)) nachId.get(t.id).klassen.push(k.id);
  }
  for (const [id, k] of Object.entries(klassen)) {
    if (!div[id]) continue;
    div[id].spiele = k.spiele.map(spiel).sort((a, b) => a.d.localeCompare(b.d) || a.h.n.localeCompare(b.h.n));
    div[id].tabelle = k.tabelle ? tabelle(k.tabelle) : null;
  }
  // Keine Ergebnisse bei den Kleinen, auch nicht in ihren Freundschaftsspielen. Nur unsere Spiele.
  const ohneErg = new Set([...nachId].filter(([, t]) => KEINE_ERG.includes(t.kat)).map(([id]) => id));
  for (const k of Object.values(div)) for (const sp of k.spiele)
    if (ohneErg.has(sp.h.id) || ohneErg.has(sp.a.id)) sp.hs = sp.as = null;

  // Pokal-/Freundschaftsmannschaften ohne Ligaspiel bekommen keinen eigenen Reiter: ohne I/II hängen sie an
  // allen derselben Altersklasse, mit I/II an der gleichnamigen. Ohne I/II mit Ligaspiel neben einer „I“ = dieselbe.
  const liga = t => t.klassen.some(id => div[id].typ === "CC");
  for (const t of [...teams.values()]) {
    if (zusatz(t.n) || !liga(t)) continue;
    const eins = [...teams.values()].find(o => o.kat === t.kat && zusatz(o.n) === "I");
    if (!eins) continue;
    eins.ids.push(...t.ids);
    eins.klassen.push(...t.klassen.filter(id => !eins.klassen.includes(id)));
    teams.delete(t.kat + "|" + t.n);
  }
  const alle = [...teams.values()];
  for (const t of alle) t.klassen.sort((a, b) => div[a].start.localeCompare(div[b].start));
  const reiterTeams = alle.filter(liga);
  // Altersklasse ohne Liga (nur Pokal/Freundschaft): die Pokalmannschaft bekommt selbst einen Reiter.
  for (const t of alle) if (!liga(t) && !reiterTeams.some(o => o.kat === t.kat) && !zusatz(t.n)) reiterTeams.push(t);
  for (const t of reiterTeams) {
    const kat = KATS.find(k => k.key === t.kat);
    const andere = reiterTeams.filter(o => o !== t && o.kat === t.kat);
    const z = zusatz(t.n);
    t.nr = ROEM[z] || (andere.length ? 1 : 0);
    t.reiter = kat.kurz + (t.nr && andere.length ? " " + t.nr : "");
    t.alter = kat.n;
    // Pokal-/Freundschaftsmannschaft ohne I/II gehört zur „I“ (die FLF nennt MIN 1 im Pokal „Jeunesse Junglinster“,
    // in der Liga „… I“; vom Verein, 8.11.2026). Gibt es keine „I“, hängt sie an allen der Altersklasse.
    const hatEins = reiterTeams.some(o => o.kat === t.kat && zusatz(o.n) === "I");
    t.mit = alle.filter(o => !reiterTeams.includes(o) && o.kat === t.kat
      && (zusatz(o.n) ? zusatz(o.n) === z : !hatEins || z === "I")).flatMap(o => o.ids);
  }
  const reihe = k => KATS.findIndex(x => x.key === k);
  return {
    stand: new Date().toISOString(),
    saison: { id: saison.id, n: saison.name },
    verein: { id: club, n: VEREIN },
    teams: reiterTeams.sort((a, b) => reihe(a.kat) - reihe(b.kat) || a.nr - b.nr),
    klassen: div,
  };
}

// Bambinis (aus den PDFs) dazulegen.
export function bamDazu(D, bam) {
  if (!bam?.teams?.length) return;
  const viele = bam.teams.length > 1;
  for (const t of bam.teams) Object.assign(t, { reiter: "BAM" + (viele ? " " + t.nr : ""), alter: "Bambinis U7", mit: [] });
  D.teams = [...bam.teams, ...D.teams.filter(t => t.kat !== "U7")];
  Object.assign(D.klassen, bam.klassen);
}
export function bamAus(D) {
  const teams = D?.teams?.filter(t => t.kat === "U7") || [];
  return teams.length ? { teams, klassen: Object.fromEntries(teams.flatMap(t => t.klassen).map(id => [id, D.klassen[id]]).filter(([, k]) => k)) } : null;
}

// Alle Spiele einer Reiter-Mannschaft.
export function eigeneSpiele(D, t) {
  const ids = new Set([...t.ids, ...(t.mit || [])]);
  const klassen = new Set(Object.values(D.klassen).filter(k => k.spiele.some(sp => ids.has(sp.h.id) || ids.has(sp.a.id))).map(k => k.id));
  const aus = [];
  for (const id of klassen) {
    const k = D.klassen[id];
    for (const sp of k.spiele) if (ids.has(sp.h.id) || ids.has(sp.a.id))
      aus.push({ ...sp, klasse: k.n, typ: k.typ, erg: k.ergebnisse && !KEINE_ERG.includes(t.kat) });
  }
  return aus.sort((a, b) => a.d.localeCompare(b.d));
}

// ---- Kalender (iCalendar) je Reiter, abonniert über webcal:// auf GitHub Pages ----
const icsText = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
const utc = iso => new Date(iso).toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
const ortsZeit = iso => new Date(iso).toLocaleString("sv-SE", { timeZone: "Europe/Luxembourg" });
function falten(z) {
  if (Buffer.byteLength(z, "utf8") <= 75) return z;
  const teile = []; let rest = z, erste = true;
  while (Buffer.byteLength(rest, "utf8") > (erste ? 75 : 74)) {
    const n = erste ? 75 : 74; let s = "";
    for (const ch of rest) { if (Buffer.byteLength(s + ch, "utf8") > n) break; s += ch; }
    teile.push((erste ? "" : " ") + s); rest = rest.slice(s.length); erste = false;
  }
  teile.push(" " + rest);
  return teile.join("\r\n");
}
export const dateiName = t => t.reiter.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "-") + ".ics";
export function ics(D, t) {
  const unsere = new Set([...t.ids, ...(t.mit || [])]);
  const name = x => unsere.has(x.id) ? "FCJJ " + t.reiter : x.n;
  const dauer = ["SEN", "RES", "VET"].includes(t.kat) ? 120 : KEINE_ERG.includes(t.kat) ? 90 : 105;
  const z = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//FC Jeunesse Junglinster//App//DE", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsText("FCJJ " + t.reiter)}`, "X-WR-TIMEZONE:Europe/Luxembourg", "REFRESH-INTERVAL;VALUE=DURATION:PT3H", "X-PUBLISHED-TTL:PT3H"];
  for (const sp of eigeneSpiele(D, t)) {
    // „Uhrzeit offen“ schreibt die FLF als 00:00 (auch 00:00:01, 01:00, 01:30): alles vor 6 Uhr.
    const offen = +ortsZeit(sp.d).slice(11, 13) < 6;
    const art = sp.typ === "CUP" ? " (Pokal)" : sp.typ === "FM" ? " (Freundschaftsspiel)" : "";
    const erg = sp.erg && sp.gespielt && sp.hs != null ? ` ${sp.hs}:${sp.as}` : "";
    const titel = sp.bam ? `⚽ FCJJ ${t.reiter} · Mini-Spieltag` : `⚽ ${name(sp.h)} – ${name(sp.a)}${erg}${art}`;
    z.push("BEGIN:VEVENT", `UID:flf-${sp.id}-${t.id}@fcjj-app`, "DTSTAMP:20260701T000000Z",
      `DTSTART:${utc(sp.d)}`, `DTEND:${utc(new Date(Date.parse(sp.d) + dauer * 60e3).toISOString())}`,
      `SUMMARY:${icsText(titel + (offen ? " · Uhrzeit offen" : ""))}`);
    if (sp.ort) z.push(`LOCATION:${icsText(sp.ort)}`);
    z.push(`DESCRIPTION:${icsText(sp.klasse + (sp.tag ? `, Spieltag ${sp.tag}` : "") + (sp.bam ? `\nMit ${sp.bam.mit.join(", ")}` : ""))}`, "END:VEVENT");
  }
  z.push("END:VCALENDAR");
  return z.map(falten).join("\r\n") + "\r\n";
}

// ---- Verein und Altersklassen finden ----
// Vereinsnummer vom Verein (7.11.2026). Wird beim ersten Lauf geprüft: Hat die FLF unter dieser Nummer
// keine Spiele von „Jeunesse Junglinster“ (z. B. weil es die Nummer von flf.lu und nicht die des Extranets
// ist), sucht der Abruf die richtige selbst über eine bekannte Mannschaft.
export const CLUB = 500062;
async function passtClub(zeit, id) {
  try {
    const { matches } = await gq(Q_MATCHES, { c: { ...zeit, clubId: id, ageCategoryId: 1, matchTypeId: "ALL" } });
    return matches.some(m => [m.homeTeam, m.awayTeam].some(t => t.name.startsWith(VEREIN) && vereinsIds(t).includes(id)));
  } catch (e) { return false; }
}
async function vereinFinden(zeit, alt) {
  if (process.env.FCJJ_CLUB) return +process.env.FCJJ_CLUB;
  if (alt?.verein?.id) return alt.verein.id;
  if (await passtClub(zeit, CLUB)) { console.log("Vereinsnummer", CLUB, "stimmt"); return CLUB; }
  console.log("Vereinsnummer", CLUB, "liefert keine FCJJ-Spiele — suche selbst");
  const { matches } = await gq(Q_MATCHES, { c: { ...zeit, teamId: BEKANNTE_MANNSCHAFT, matchTypeId: "ALL" } });
  for (const m of matches) for (const t of [m.homeTeam, m.awayTeam])
    if (t.name.startsWith(VEREIN) && vereinsIds(t).length) { console.log("Verein gefunden:", t.name, vereinsIds(t)[0]); return vereinsIds(t)[0]; }
  throw new Error("Vereinsnummer nicht gefunden (Mannschaft " + BEKANNTE_MANNSCHAFT + ")");
}
// {ageCategoryId: key}. Bekannte Nummern direkt, die übrigen 1–40 einmal am Tag durchsuchen.
async function kategorienFinden(zeit, club, alt) {
  const heute = new Date().toISOString().slice(0, 10);
  if (!process.env.NEU_SUCHEN && alt?.kategorien?.tag === heute && alt.kategorien.saison === zeit.seasonId) return alt.kategorien;
  const ids = Object.fromEntries(KATS.filter(k => k.id).map(k => [k.id, k.key]));
  const gefunden = { ...ids }, gesehen = {};
  for (let id = 1; id <= 60; id++) {
    if (ids[id]) continue;
    try {
      const { matches } = await gq(Q_MATCHES, { c: { ...zeit, clubId: club, ageCategoryId: id, matchTypeId: "ALL" } });
      if (matches.length) {
        const namen = [...new Set(matches.map(m => m.division.name))];
        const unsere = [...new Set(matches.flatMap(m => [m.homeTeam, m.awayTeam]).filter(t => vereinsIds(t).includes(club)).map(t => t.name))];
        gesehen[id] = { klassen: namen, teams: unsere, spiele: matches.length, erstes: matches.map(m => m.match.matchDate).sort()[0] };
        const key = katAusNamen(namen);
        if (key && !Object.values(gefunden).includes(key)) gefunden[id] = key;
        console.log(`Altersklasse ${id}: ${key || "nicht gewünscht"} — ${namen.slice(0, 4).join(" | ")} — ${unsere.join(", ")}`);
        if (!key) for (const m of matches.slice(0, 6)) console.log(`   ${m.match.matchDate} ${m.homeTeam.name} – ${m.awayTeam.name} (${m.division.name})`);
      }
    } catch (e) { /* unbekannte Nummer */ }
    await pause(700);
  }
  return { tag: heute, saison: zeit.seasonId, ids: gefunden, gesehen };
}

async function main() {
  const alt = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
  const d = await gq(Q_DEFAULTS);
  const saison = d.seasons.find(s => s.id === d.defaultValues.currentSeasonId);
  if (!saison) throw new Error("Saison nicht gefunden");
  const zeit = { seasonId: saison.id, startDate: day(saison.startDate), endDate: day(saison.endDate) };
  const club = await vereinFinden(zeit, alt);
  const kategorien = await kategorienFinden(zeit, club, alt);

  const vereinsSpiele = [];
  for (const [ageId, kat] of Object.entries(kategorien.ids)) {
    const { matches } = await gq(Q_MATCHES, { c: { ...zeit, clubId: club, ageCategoryId: +ageId, matchTypeId: "ALL" } });
    for (const m of matches) if (!vereinsSpiele.some(x => x.match.id === m.match.id)) vereinsSpiele.push({ ...m, kat });
    await pause(1000);
  }
  const klassen = {};
  for (const id of new Set(vereinsSpiele.map(m => m.division.id))) {
    const m0 = vereinsSpiele.find(m => m.division.id === id);
    const typ = m0.matchType?.id || "ALL";
    // Freundschaftsspiele liegen landesweit in einer Klasse — davon nur die eigenen.
    if (typ === "FM") { klassen[id] = { spiele: vereinsSpiele.filter(m => m.division.id === id), tabelle: null }; continue; }
    await pause(1000);
    const { matches } = await gq(Q_MATCHES, { c: { ...zeit, divisionId: id, matchTypeId: typ } });
    let tab = null;
    if (m0.division.showRanking && typ === "CC") {
      await pause(1000);
      tab = (await gq(Q_RANKING, { c: { seasonId: saison.id, divisionId: id, matchTypeId: typ } })).rankings;
    }
    klassen[id] = { spiele: matches, tabelle: tab };
  }
  const neu = aufbereiten({ saison, club, vereinsSpiele, klassen });
  neu.kategorien = kategorien;

  // Bambinis aus den FLF-PDFs. Fehler → alter Stand, der Rest läuft weiter.
  let bam = null;
  try { bam = await (await import("./bambini.mjs")).bamHolen(); console.log("Bambinis:", bam.quellen.join(", ")); }
  catch (e) { console.error("Bambinis:", e.message); bam = bamAus(alt); }
  bamDazu(neu, bam);
  // Nationalmannschaft von FuPa. Fehler → alter Stand, der Rest läuft weiter.
  try { neu.nati = await (await import("./nati.mjs")).natiHolen(); console.log("Nationalmannschaft:", neu.nati.spiele.length, "Spiele,", neu.nati.gruppe?.n || "ohne Tabelle"); }
  catch (e) { console.error("Nationalmannschaft:", e.message); neu.nati = alt.nati || null; }
  for (const t of neu.teams) t.datei = dateiName(t);

  if (JSON.stringify({ ...alt, stand: 0, kategorien: 0 }) === JSON.stringify({ ...neu, stand: 0, kategorien: 0 }) && alt.kategorien?.tag === kategorien.tag && !process.env.NEU_SUCHEN) {
    console.log("unverändert");
  } else {
    writeFileSync(OUT, JSON.stringify(neu, null, 1) + "\n");
    console.log("geschrieben:", neu.teams.map(t => t.reiter).join(", "));
  }
}

function kalender() {
  const D = JSON.parse(readFileSync(OUT, "utf8"));
  mkdirSync(KAL, { recursive: true });
  const soll = new Set();
  for (const t of D.teams) { writeFileSync(new URL(t.datei, KAL), ics(D, t)); soll.add(t.datei); }
  for (const f of readdirSync(KAL)) if (f.endsWith(".ics") && !soll.has(f)) unlinkSync(new URL(f, KAL));
  console.log("Kalender:", [...soll].join(", "));
}

if (import.meta.url === `file://${process.argv[1]}`)
  main().then(kalender).catch(e => { console.error(e); process.exit(1); });
