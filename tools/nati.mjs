// Spiele der Nationalmannschaft (Roude Léiw). Die FLF führt keine Länderspiele im Extranet, darum von FuPa.
// Übernommen aus fckoeppchen.github.io (tools/fussball.mjs, natiHolen u. a.).
const FUPA = "https://api.fupa.net/v1/";

// FuPa-Spiel der Nationalmannschaft → Format der App (Mannschaften über den Namen, FuPa schreibt
// sie deutsch: „Estland“). `wett` = Wettbewerb, `runde` = „C4“, „PlayOff-C/D-Hinspiel“ …
export function natiSpiel(m) {
  const n = t => t.name?.full || t.name || "";
  const r = m.round || {};
  return {
    id: m.id, d: m.kickoff, slug: m.slug,
    h: { id: n(m.homeTeam), n: n(m.homeTeam) }, a: { id: n(m.awayTeam), n: n(m.awayTeam) },
    hs: m.homeGoal ?? null, as: m.awayGoal ?? null, gespielt: m.section === "POST",
    wett: r.competitionSeason?.name || m.competition?.name || "", runde: r.title || null,
  };
}

// Welche Gruppe zeigt der Reiter? Die des nächsten Pflichtspiels, sonst die des letzten. Pflicht =
// Gruppenrunde (`cupgroup`) oder Liga, aber kein Testspiel (Kategorie 6) und keine K.-o.-Runde
// (keine Tabelle). Kommt die Qualifikation, wechselt die Tabelle so von selbst.
export function natiGruppe(roh, now) {
  const pflicht = roh.filter(m => m.round && m.round.slug && m.round.competitionSeason?.slug
    && (m.round.type === "cupgroup" || m.round.type === "league") && m.round.competitionSeason.category?.id !== 6)
    .sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const m = pflicht.find(m => m.section !== "POST" && Date.parse(m.kickoff) >= now - 3 * 3600e3) || pflicht[pflicht.length - 1];
  if (!m) return null;
  const c = m.round.competitionSeason;
  return { comp: c.slug, group: m.round.slug, n: c.name + (m.round.type === "cupgroup" ? " · Gruppe " + m.round.title : "") };
}

export function natiTabelle(standings) {
  return (standings || []).map(r => ({ pl: r.rank, id: r.team.name.full, n: r.team.name.full, sp: r.matches,
    s: r.wins, u: r.draws, nl: r.defeats, t: r.ownGoals, g: r.againstGoals, pkt: r.points }));
}

async function fupa(pfad) {
  const r = await fetch(FUPA + pfad, { headers: { accept: "application/json" } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error("FuPa HTTP " + r.status + " " + pfad);
  return r.json();
}

export async function natiHolen() {
  // FuPa führt Nationalteams je Kalenderjahr (luxemburg-m1-2026); um den Jahreswechsel liegen
  // Spiele in zwei Jahren — darum drei Jahre, Doppelte über die ID raus.
  const y = new Date().getFullYear(), roh = new Map();
  for (const j of [y - 1, y, y + 1])
    for (const flavor of ["past", "current"]) {
      const l = await fupa(`teams/luxemburg-m1-${j}/matches?flavor=${flavor}`);
      if (Array.isArray(l)) for (const m of l) roh.set(m.id, m);
    }
  if (!roh.size) throw new Error("FuPa: keine Spiele der Nationalmannschaft");
  const alle = [...roh.values()];
  const g = natiGruppe(alle, Date.now());
  let gruppe = null;
  if (g) {
    const st = await fupa(`standings?competition=${g.comp}&group=${g.group}`);
    if (st?.standings?.length) gruppe = { n: g.n, tabelle: natiTabelle(st.standings) };
  }
  const spiele = alle.map(natiSpiel).sort((a, b) => a.d.localeCompare(b.d));
  // Stadion steht nur im einzelnen Spiel, nicht in der Liste: für die nächsten drei nachfragen
  // („Heute Spieltag“-Kasten).
  for (const sp of spiele.filter(s => !s.gespielt && Date.parse(s.d) > Date.now() - 6 * 3600e3).slice(0, 3)) {
    try { const m = await fupa("matches/" + sp.slug); if (m?.venue?.name) sp.ort = m.venue.name; } catch (e) {}
  }
  return { spiele, gruppe };
}

