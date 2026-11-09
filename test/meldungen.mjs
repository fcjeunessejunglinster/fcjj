// Prüft die Push-Meldungen mit dem echten Datenstand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { meldungen } from "../tools/meldungen.mjs";
import { eigeneSpiele } from "../tools/abruf.mjs";
const D = JSON.parse(readFileSync(new URL("../data/fussball.json", import.meta.url)));
const kopie = x => JSON.parse(JSON.stringify(x));
const min1 = D.teams.find(t => t.reiter === "MIN 1"), sen = D.teams.find(t => t.reiter === "Seniors");
const spSen = eigeneSpiele(D, sen).filter(sp => sp.erg && sp.gespielt && sp.hs != null).at(-1);
const spMin = eigeneSpiele(D, min1).filter(sp => sp.erg && sp.gespielt && sp.hs != null).at(-1);
// alter Stand: diese beiden Spiele noch ohne Ergebnis
const alt = kopie(D);
for (const k of Object.values(alt.klassen)) for (const sp of k.spiele) if (sp.id === spSen.id || sp.id === spMin.id) { sp.gespielt = false; sp.hs = sp.as = null; }
let jetzt = new Date(+new Date(spSen.d) + 3 * 3600e3);
let ev = meldungen(alt, D, jetzt);
const e1 = ev.find(e => e.id.startsWith("erg:" + spSen.id));
assert.ok(e1, "Ergebnis Seniors");
console.log(e1.t.de, "|", e1.b.de, "|", e1.b.fr);
const e2 = meldungen(alt, D, new Date(+new Date(spMin.d) + 3 * 3600e3)).find(e => e.id.startsWith("erg:" + spMin.id)); console.log(e2?.b.de);
// unverändert → keine Ergebnismeldung
assert.equal(meldungen(D, D, jetzt).filter(e => e.id.startsWith("erg:")).length, 0);
// Verlegung eines künftigen Spiels
const zuk = eigeneSpiele(D, min1).find(sp => !sp.gespielt && new Date(sp.d) > new Date("2026-11-10"));
if (zuk) {
  const alt2 = kopie(D);
  for (const k of Object.values(alt2.klassen)) for (const sp of k.spiele) if (sp.id === zuk.id) sp.d = new Date(+new Date(sp.d) - 7 * 864e5).toISOString().replace(".000Z", "+00:00");
  const v = meldungen(alt2, D, new Date("2026-11-10T12:00:00+01:00")).filter(e => e.id.startsWith("verl:"));
  console.log(v.map(e => e.b.de + " | " + e.b.en + " | " + e.b.fr));
  assert.ok(v.length >= 1);
}
// Erinnerung: Tag vor einem Spiel
const naechst = eigeneSpiele(D, min1).find(sp => !sp.gespielt && new Date(sp.d) > new Date("2026-11-10"));
jetzt = new Date(+new Date(naechst.d) - 864e5);
jetzt = new Date(jetzt.toISOString().slice(0, 10) + "T09:00:00+01:00");
const er = meldungen(D, D, jetzt).filter(e => e.id.startsWith("erin:" + min1.id));
assert.equal(er.length, 1);
console.log(er[0].ab, er[0].bis, er[0].b.de, "|", er[0].b.fr);
assert.match(er[0].ab, /T17:00:00/);   // 18:00 Winterzeit
// alte Meldungen bleiben, abgelaufene fallen weg
const m2 = meldungen(D, D, jetzt, [{ id: "x", ab: "2026-01-01T00:00:00Z", bis: "2099-01-01T00:00:00Z" }, { id: "y", ab: "2026-01-01T00:00:00Z", bis: "2026-01-02T00:00:00Z" }]);
assert.ok(m2.some(e => e.id === "x") && !m2.some(e => e.id === "y"));
console.log("Meldungen-Test ok");
