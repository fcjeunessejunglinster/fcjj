// Übernommen aus fckoeppchen.github.io (tools/bambini.mjs) und für den FCJJ angepasst.
// BAM (Bambinis U7): stehen nicht im Extranet, nur als PDF auf www.flf.lu (vom Verein, 24.10.2026).
// „Programmes généraux“ hat den ganzen Plan einer Tour (ohne Uhrzeiten), „Programme hebdomadaire“ je
// Samstag ein PDF mit Uhrzeiten („Coup d'envoi 10.30 hrs (sauf modification)“, andere Zeit hinter dem Platz).
// Je Spieltag vier Mini-Spieltage nebeneinander: Platz, darunter bis zu vier Mannschaften („-“ = frei).
//
// Gelesen wird mit `pdftotext -bbox` (Lage jedes Wortes), nicht mit -layout: die Spalten stehen an festen
// Stellen, lange Namen laufen aber über. Wer hier etwas ändert: lieber nichts als etwas Falsches —
// passt ein Spieltag mit uns nicht ins Muster, bricht das Lesen ab und der alte Stand bleibt.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SEITEN = {
  generaux: "https://www.flf.lu/generaux-92804v4",
  hebdo: "https://www.flf.lu/hebdomadaires-92803v4",
};
// Name des Vereins in den Bambini-PDFs der FLF.
export const NAME = "Jeunesse Junglinster";
export const WIR = new RegExp(`^${NAME}( (I|II|III|IV))?$`);
export const HEIM = /Junglinster/i;
const TZ = "Europe/Luxembourg";

// PDF-Liste einer Seite: [{url, name}] aus dem eingebetteten JSON der Seite.
export function pdfListe(html) {
  const s = html.replace(/\\"/g, '"');
  const aus = [], gesehen = new Set();
  for (const m of s.matchAll(/\{"url":"(https:[^"]+\.pdf)","mime":"application\/pdf","name":"([^"]+)"/g))
    if (!gesehen.has(m[1])) { gesehen.add(m[1]); aus.push({ url: m[1], name: m[2] }); }
  return aus;
}

const ent = t => t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// Wörter je Seite aus `pdftotext -bbox`: [[{x0, x1, y, t}]].
export function bboxSeiten(html) {
  return html.split("<page ").slice(1).map(p =>
    [...p.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="[\d.]+">([^<]*)<\/word>/g)]
      .map(m => ({ x0: +m[1], y: +m[2], x1: +m[3], t: ent(m[4]) })));
}

// Zeilen (gleiche Höhe ±2) und darin Zellen (Lücke > 12 pt zwischen Wörtern).
function zeilen(woerter) {
  const z = [];
  for (const w of [...woerter].sort((a, b) => a.y - b.y || a.x0 - b.x0)) {
    const r = z.find(r => Math.abs(r.y - w.y) < 2);
    r ? r.w.push(w) : z.push({ y: w.y, w: [w] });
  }
  for (const r of z) {
    r.w.sort((a, b) => a.x0 - b.x0);
    r.zellen = [];
    for (const w of r.w) {
      const c = r.zellen[r.zellen.length - 1];
      if (c && w.x0 - c.x1 <= 12) { c.t += " " + w.t; c.x1 = w.x1; } else r.zellen.push({ x0: w.x0, x1: w.x1, t: w.t });
    }
    r.text = r.zellen.map(c => c.t).join(" ");
  }
  return z;
}

// Uhrzeit hinter dem Platz („… 9h30“) → "09:30" und Platz ohne Zeit.
export function zeitAusOrt(ort) {
  const m = ort.match(/\s*(\d{1,2})h(\d{2})\s*$/);
  return m ? { ort: ort.slice(0, m.index).trim(), zeit: m[1].padStart(2, "0") + ":" + m[2] } : { ort: ort.trim(), zeit: null };
}

// Alle Mini-Spieltage mit uns aus einem PDF: [{datum, journee, serie, ort, zeit, teams[]}].
// `standard` = Anstoßzeit aus dem Kopf („Coup d'envoi 10.30 hrs“), sonst null.
export function turniere(seiten) {
  const aus = [];
  let serie = null, standard = null;
  for (const woerter of seiten) {
    const z = zeilen(woerter);
    const kopf = z.map(r => r.text).join(" ");
    const k = kopf.match(/Coup d.envoi (\d{1,2})[.:h](\d{2})/i);
    if (k) standard = k[1].padStart(2, "0") + ":" + k[2];
    // Spaltenanfänge der Seite: die häufigsten Zellanfänge (auf 6 pt gerundet), höchstens vier.
    const zaehl = new Map();
    for (const r of z) for (const c of r.zellen) { const x = Math.round(c.x0 / 6) * 6; zaehl.set(x, (zaehl.get(x) || 0) + 1); }
    const spalten = [...zaehl].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([x]) => x).sort((a, b) => a - b);
    const spalte = x => { let i = -1; spalten.forEach((s, j) => { if (x >= s - 8) i = j; }); return i; };
    let block = null;
    const fertig = () => {
      if (!block) return;
      const b = block; block = null;
      if (!b.rows.some(r => r.zellen.some(c => WIR.test(c.t)))) return;
      // Die letzten vier Zeilen sind die Mannschaften, davor steht der Platz (eine oder zwei Zeilen).
      if (b.rows.length < 5 || b.rows.length > 6) throw new Error(`BAM ${b.datum}: ${b.rows.length} Zeilen im Spieltag`);
      const teamZ = b.rows.slice(-4), ortZ = b.rows.slice(0, -4);
      for (let s = 0; s < 4; s++) {
        // Jedes Wort für sich nach seiner Lage — eine Zelle könnte sonst über die Spaltengrenze reichen.
        const teams = teamZ.map(r => r.w.filter(w => spalte(w.x0) === s).map(w => w.t).join(" ").trim()).filter(t => t && t !== "-");
        if (!teams.some(t => WIR.test(t))) continue;
        const roh = ortZ.map(r => r.w.filter(w => spalte(w.x0) === s).map(w => w.t).join(" ")).join(" ").replace(/\s+/g, " ").trim();
        if (!roh || teams.length < 2 || teams.length > 4) throw new Error(`BAM ${b.datum}: Spalte ${s + 1} unklar (${roh} / ${teams.join(", ")})`);
        const { ort, zeit } = zeitAusOrt(roh);
        aus.push({ datum: b.datum, journee: b.journee, serie, ort, zeit: zeit || standard, zeitSicher: !!(zeit || standard), teams });
      }
    };
    for (const r of z) {
      const s = r.text.match(/^Bambinis s[ée]rie (\d+)/i);
      if (s) { fertig(); serie = +s[1]; continue; }
      const j = r.text.match(/^Journée (\d+)\s*[–-]\s*(\d{2})\/(\d{2})\/(\d{2,4})/);
      if (j) { fertig(); const y = j[4].length === 2 ? "20" + j[4] : j[4]; block = { journee: +j[1], datum: `${y}-${j[3]}-${j[2]}`, rows: [] }; continue; }
      if (block) block.rows.push(r);
    }
    fertig();
  }
  return aus;
}

// Ortszeit → ISO mit Versatz, wie die FLF (z. B. 2026-10-24T10:30:00+02:00).
export function isoLux(datum, zeit) {
  const [h, m] = (zeit || "00:00").split(":").map(Number);
  const probe = Date.UTC(+datum.slice(0, 4), +datum.slice(5, 7) - 1, +datum.slice(8, 10), h, m);
  for (const v of [1, 2]) {
    const t = probe - v * 3600e3;
    const l = new Date(t).toLocaleString("sv-SE", { timeZone: TZ, hour12: false }).slice(0, 16).replace(" ", "T");
    if (l === `${datum}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`) return `${datum}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+0${v}:00`;
  }
  throw new Error("Zeit " + datum + " " + zeit);
}

// Aus den Turnieren Mannschaften und Klassen im Format von aufbereiten() (tools/abruf.mjs).
// Wochen-PDF schlägt Gesamtplan (gleicher Tag + Mannschaft).
const NR = { I: 1, II: 2, III: 3, IV: 4 };
export function bamDaten(allgemein, woche) {
  const je = new Map();
  for (const [quelle, liste] of [["plan", allgemein], ["woche", woche]])
    for (const t of liste) for (const n of t.teams.filter(n => WIR.test(n))) {
      const nr = n.match(/ (I|II|III|IV)$/)?.[1] || "I";
      je.set(`${t.datum}|${nr}`, { ...t, nr, wir: n, quelle });
    }
  const klassen = {}, teams = {};
  for (const x of [...je.values()].sort((a, b) => a.datum.localeCompare(b.datum))) {
    const kid = "bam-" + x.serie;
    klassen[kid] ??= { id: kid, n: `Bambinis série ${x.serie}`, typ: "CC", ergebnisse: false, tabelle: null, spiele: [], start: x.datum };
    const id = 9000700 + NR[x.nr], heim = HEIM.test(x.ort);
    const andere = x.teams.filter(n => n !== x.wir);
    const wir = { id, n: `${NAME} ${x.nr}` }, tur = { id: 0, n: "Mini-Spieltag mit " + andere.join(", ") };
    klassen[kid].spiele.push({ id: Number(`9${x.datum.replace(/-/g, "")}${NR[x.nr]}`), d: isoLux(x.datum, x.zeit || "10:30"),
      tag: x.journee, h: heim ? wir : tur, a: heim ? tur : wir, hs: null, as: null, gespielt: false, forfait: false, ort: x.ort,
      bam: { mit: andere, zeitSicher: x.quelle === "woche" && x.zeitSicher } });
    teams[x.nr] ??= { id, ids: [id], n: `${NAME} ${x.nr}`, kat: "U7", nr: NR[x.nr], klassen: [] };
    if (!teams[x.nr].klassen.includes(kid)) teams[x.nr].klassen.push(kid);
  }
  return { teams: Object.values(teams).sort((a, b) => a.nr - b.nr), klassen };
}

// PDF → Wörter (braucht pdftotext aus poppler-utils).
function pdfWoerter(buf) {
  const dir = mkdtempSync(join(tmpdir(), "bam-"));
  try {
    writeFileSync(join(dir, "a.pdf"), buf);
    execFileSync("pdftotext", ["-bbox", join(dir, "a.pdf"), join(dir, "a.html")]);
    return bboxSeiten(execFileSync("cat", [join(dir, "a.html")]).toString("utf8"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

async function holen(url, als = "text") {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return als === "text" ? await r.text() : Buffer.from(await r.arrayBuffer());
      if (r.status < 500) throw new Error(url + " " + r.status);
    } catch (e) { if (i === 2) throw e; }
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Alles zusammen. Wirft bei jedem Zweifel — der Aufrufer behält dann den alten Stand.
export async function bamHolen() {
  const plan = pdfListe(await holen(SEITEN.generaux)).filter(p => /U7.*Bambini/i.test(p.name));
  const woche = pdfListe(await holen(SEITEN.hebdo)).filter(p => /Bambini/i.test(p.name));
  if (!plan.length) throw new Error("BAM: kein Gesamtplan auf " + SEITEN.generaux);
  const a = [], w = [];
  for (const p of plan) a.push(...turniere(pdfWoerter(await holen(p.url, "buf"))));
  for (const p of woche) w.push(...turniere(pdfWoerter(await holen(p.url, "buf"))));
  if (!a.length) throw new Error("BAM: im Gesamtplan kein Turnier mit " + NAME);
  return { ...bamDaten(a, w), quellen: [...plan, ...woche].map(p => p.name) };
}
