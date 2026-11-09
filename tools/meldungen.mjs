// Push-Meldungen für die App: vergleicht den alten mit dem neuen Datenstand und schreibt data/meldungen.json.
// Der Cloudflare-Worker liest die Datei und verschickt jede Meldung einmal (zwischen `ab` und `bis`).
//  - erg:  neues Ergebnis (nur wo die App Ergebnisse zeigt; Jugend-Sieg mit #YOUth ROCKs!)
//  - verl: Spiel verlegt (Tag oder Anstoßzeit geändert, Spiel in der Zukunft)
//  - erin: „Morgen Spieltag!“ am Vortag um 18 Uhr
import { eigeneSpiele } from "./abruf.mjs";

const SPRACHEN = { de: "de-DE", en: "en-GB", fr: "fr-FR" };
const TX = {
  de: { neu: "Neuer Termin: ", morgen: "Morgen Spieltag! ", offen: "Uhrzeit offen", forfait: " (Forfait)" },
  en: { neu: "New date: ", morgen: "Matchday tomorrow! ", offen: "time to be confirmed", forfait: " (forfeit)" },
  fr: { neu: "Nouvelle date : ", morgen: "Demain jour de match ! ", offen: "heure à confirmer", forfait: " (forfait)" },
};
const ROCKS = " #YOUth ROCKs! 🤘";
const ERWACHSENE = ["SEN", "RES", "VET"];
const STD = 3600e3;

const lux = (d, o) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Luxembourg", ...o }).format(d);
const tagKey = d => lux(d, { year: "numeric", month: "2-digit", day: "2-digit" });   // 2026-11-14
const offen = sp => +lux(new Date(sp.d), { hour: "2-digit", hourCycle: "h23" }) < 6;
const uhr = (sp, l) => offen(sp) ? TX[l].offen : new Date(sp.d).toLocaleTimeString(SPRACHEN[l], { timeZone: "Europe/Luxembourg", hour: "2-digit", minute: "2-digit" });
const datum = (sp, l) => new Date(sp.d).toLocaleDateString(SPRACHEN[l], { timeZone: "Europe/Luxembourg", weekday: "short", day: "numeric", month: "numeric" });
const kurz = n => n.replace(/^Jeunesse Junglinster/, "FCJJ");
const paarung = sp => `${kurz(sp.h.n)} – ${kurz(sp.a.n)}`;
const alle = f => Object.fromEntries(Object.keys(TX).map(l => [l, f(l)]));
// Luxemburger Uhrzeit `hh:mm` am Tag `tag` (YYYY-MM-DD) als Zeitpunkt (Sommer/Winter richtig).
function luxZeit(tag, hhmm) {
  const roh = Date.parse(`${tag}T${hhmm}:00Z`);
  const versatz = +lux(new Date(roh), { hour: "2-digit", hourCycle: "h23" }) - +hhmm.slice(0, 2);
  return new Date(roh - ((versatz + 24) % 24) * STD);
}
const gespielt = sp => (sp.gespielt || sp.forfait) && sp.hs != null;
const sieg = (sp, ids) => ids.has(sp.h.id) ? sp.hs > sp.as : sp.as > sp.hs;

export function meldungen(alt, neu, jetzt = new Date(), vorher = []) {
  const ev = [];
  const iso = d => new Date(d).toISOString();
  const altSpiele = new Map();
  if (alt?.klassen) for (const k of Object.values(alt.klassen)) for (const sp of k.spiele) altSpiele.set(String(sp.id), sp);
  const morgen = tagKey(new Date(+jetzt + 24 * STD));
  for (const t of neu.teams || []) {
    const ids = new Set([...t.ids, ...(t.mit || [])]);
    const titel = alle(() => "FCJJ " + t.reiter);
    const spiele = eigeneSpiele(neu, t);
    const verl = [];
    for (const sp of spiele) {
      const a = altSpiele.get(String(sp.id));
      // Neues Ergebnis (höchstens 3 Tage nach dem Spiel; ohne alten Stand nichts melden)
      if (sp.erg && gespielt(sp) && a && !gespielt(a) && jetzt - new Date(sp.d) < 72 * STD) {
        const rocks = !ERWACHSENE.includes(t.kat) && sieg(sp, ids) ? ROCKS : "";
        ev.push({ id: `erg:${sp.id}:${t.id}`, team: t.id, ab: iso(jetzt), bis: iso(+jetzt + 12 * STD), t: titel,
          b: alle(l => `${paarung(sp)} ${sp.hs}:${sp.as}${sp.forfait ? TX[l].forfait : ""}${rocks}`) });
      }
      // Verlegt: Termin geändert, Spiel noch nicht gespielt und in der Zukunft
      if (a && a.d !== sp.d && !gespielt(sp) && new Date(sp.d) > jetzt
          && !(offen(a) && offen(sp) && tagKey(new Date(a.d)) === tagKey(new Date(sp.d)))) {
        verl.push({ id: `verl:${sp.id}:${t.id}:${sp.d}`, team: t.id, ab: iso(jetzt), bis: sp.d, t: titel,
          b: alle(l => `${TX[l].neu}${datum(sp, l)}, ${uhr(sp, l)} · ${paarung(sp)}`) });
      }
    }
    // Mehr als 3 Verlegungen auf einmal: neuer Spielplan der FLF, keine Einzelmeldungen
    if (verl.length <= 3) ev.push(...verl);
    // Erinnerung am Vortag 18 Uhr (alle Spiele des nächsten Tages in einer Meldung)
    const mo = spiele.filter(sp => !gespielt(sp) && tagKey(new Date(sp.d)) === morgen);
    if (mo.length) {
      const ab = luxZeit(tagKey(jetzt), "18:00");
      ev.push({ id: `erin:${t.id}:${morgen}`, team: t.id, ab: iso(ab), bis: mo[0].d, t: titel,
        b: alle(l => TX[l].morgen + mo.map(sp => `${uhr(sp, l)} ${paarung(sp)}${sp.ort ? " · 📍 " + sp.ort : ""}`).join(" / ")) });
    }
  }
  // Ältere, noch gültige Meldungen behalten (der Worker braucht sie, falls er gerade nicht lief).
  const ids = new Set(ev.map(e => e.id));
  for (const e of vorher) if (!ids.has(e.id) && new Date(e.bis) > jetzt) ev.push(e);
  // Verlegungen desselben Spiels: nur die neueste behalten
  const neueste = new Map();
  for (const e of ev) if (e.id.startsWith("verl:")) { const k = e.id.split(":").slice(0, 3).join(":"); if (!neueste.has(k) || e.ab > neueste.get(k).ab) neueste.set(k, e); }
  return ev.filter(e => !e.id.startsWith("verl:") || neueste.get(e.id.split(":").slice(0, 3).join(":")) === e)
    .sort((x, y) => x.ab.localeCompare(y.ab) || x.id.localeCompare(y.id));
}
