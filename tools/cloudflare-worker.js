// Cloudflare Worker „fcjj“: stößt den FLF-Abruf auf GitHub pünktlich an.
// GitHub lässt geplante Läufe oft aus oder startet sie spät; Cloudflare läuft pünktlich (Cron jede Viertelstunde)
// und startet den Workflow per workflow_dispatch. GitHubs eigener Zeitplan bleibt als Reserve.
//
// Einrichten (einmalig):
//  - Worker anlegen, diesen Code einfügen, Deploy.
//  - Settings → Variables and Secrets → Secret GITHUB_TOKEN (Fine-grained Token, nur Repo fcjj, Actions: Read and write).
//  - Settings → Trigger Events → Cron Trigger „*/15 * * * *“.
//  - Live-Stand SportEasy (Jugend): Secrets SE_USER und SE_PASSWORD (eigenes SportEasy-Konto nur für die App, Mitglied der
//    Jugendteams, keine Admin-Rechte). Ohne die beiden Secrets bleibt der Live-Kasten in der App unsichtbar.
//  - Chat „Frag die App“: Secret ANTHROPIC_API_KEY (console.anthropic.com), KV-Speicher als Binding PUSH (für die Tageslimits).
//  - Buvette-Hilfe: nutzt dasselbe KV PUSH; Secret BUVETTE_KEY = Passwort für die Liste /buvette/liste?key=…;
//    Secret RESEND_API_KEY für die Mails an gilles.emeringer@fcjj.lu (siehe buvMail).
// Prüfen: Adresse des Workers im Browser öffnen → zeigt Token, Chat und den nächsten Anstoß.

const REPO = "fcjeunessejunglinster/fcjj";
const WORKFLOW = "abruf.yml";

// Luxemburger Zeit (Sommer/Winter richtig) als {tag: 0=So … 6=Sa, std, min}.
function ortszeit(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Luxembourg", weekday: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
  return { tag: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), std: +p.hour, min: +p.minute };
}

// Wann abrufen (Ortszeit, auf die Viertelstunde des Cron-Takts gerundet):
//  Sa/So 8:00–22:00 jede Viertelstunde (Spiele und Ergebnisse am Wochenende),
//  Mo–Fr 12:00 und 18:00–23:00 stündlich (Abendspiele, Veteranen montags, Nachträge der FLF),
//  jeden Tag 7:00 und 23:30.
export function abrufFaellig(d) {
  const { tag, std, min } = ortszeit(d);
  const viertel = Math.floor(min / 15) * 15;
  const wochenende = tag === 0 || tag === 6;
  if (std === 7 && viertel === 0) return true;
  if (std === 23 && viertel === 30) return true;
  if (wochenende) return std >= 8 && (std < 22 || (std === 22 && viertel === 0));
  if (viertel !== 15) return false;
  return std === 12 || (std >= 18 && std <= 23);
}

async function anstossen(env) {
  if (!env.GITHUB_TOKEN) { console.log("GITHUB_TOKEN fehlt"); return 0; }
  const r = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json",
      "user-agent": "fcjj-worker", "content-type": "application/json" },
    body: JSON.stringify({ ref: "main" }),
  });
  console.log("Anstoß:", r.status, r.status === 204 ? "ok" : await r.text());
  return r.status;
}

// ---------------------------------------------------------------- Chat „Frag die App“
// Die App schickt Frage, bisherigen Verlauf und eine Zusammenfassung ihrer Daten (Spiele, Kabinen, Termine, Links …).
// Der Worker prüft die Tageslimits, fragt Claude und gibt die Antwort zurück. Der Schlüssel bleibt hier.
const ORIGIN = "https://fcjeunessejunglinster.github.io";
const CHAT_MODELL = "claude-haiku-5-5";
const CHAT_PRO_HANDY = 20, CHAT_PRO_TAG = 300;   // Fragen pro Tag: je Anschluss (IP) und insgesamt
const SYSTEM = `Du bist der freundliche Assistent in der App des Fußballvereins FC Jeunesse Junglinster (FCJJ) in Luxemburg.
Regeln:
- Antworte kurz (meist 1–4 Sätze oder eine kurze Liste) und in der Sprache der Frage (Deutsch, Französisch, Englisch, Luxemburgisch).
- Beantworte nur Fragen zum FCJJ (Mannschaften, Spiele, Ergebnisse, Tabellen, Kabinen, Plätze, Termine, Cotisation, Formulare, Regeln) und allgemein zum Fußball.
- Stütze dich bei Vereinsfragen nur auf die Vereinsdaten unten. Erfinde keine Termine, Zeiten, Orte, Ergebnisse oder Namen. Wenn etwas nicht in den Daten steht, sag das ehrlich und verweise für die Jugendkategorien auf jeunes@fcjj.lu, sonst auf secretaire@fcjj.lu.
- Viele Nutzer sind Kinder und Jugendliche. Frag nie nach Namen, Adressen, Telefonnummern oder anderen persönlichen Daten und speichere nichts. Bleib bei anderen Themen freundlich, aber lenke zurück auf den Verein.
- Bei Verletzungen oder Notfällen: im Notfall 112 anrufen; für die Versicherung (C.S.M.S.) gilt der Ablauf in den Vereinsdaten.
- Gib Links vollständig an (https://…). Keine Werbung, keine Meinungen zu Politik oder Religion.`;
const chatCors = { "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const chatJson = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { ...chatCors, "content-type": "application/json" } });
const kurz = (x, n) => typeof x === "string" ? x.slice(0, n) : "";

async function zaehlen(env, ip, tag) {
  if (!env.PUSH) return { ok: true };   // ohne KV keine Limits (nur Anthropic-Ausgabenlimit)
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip + "fcjj")))].slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
  const kH = `chat:${tag}:${h}`, kA = `chat:${tag}:alle`;
  const [nH, nA] = (await Promise.all([env.PUSH.get(kH), env.PUSH.get(kA)])).map(x => +x || 0);
  if (nH >= CHAT_PRO_HANDY || nA >= CHAT_PRO_TAG) return { ok: false, grund: nH >= CHAT_PRO_HANDY ? "handy" : "alle" };
  await Promise.all([env.PUSH.put(kH, String(nH + 1), { expirationTtl: 172800 }), env.PUSH.put(kA, String(nA + 1), { expirationTtl: 172800 })]);
  return { ok: true, rest: CHAT_PRO_HANDY - nH - 1 };
}
export async function chat(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: chatCors });
  if (req.method !== "POST") return chatJson({ fehler: "methode" }, 405);
  if (!env.ANTHROPIC_API_KEY) return chatJson({ fehler: "aus" }, 503);
  if ((req.headers.get("origin") || "") !== ORIGIN) return chatJson({ fehler: "herkunft" }, 403);
  let x; try { x = await req.json(); } catch (e) { return chatJson({ fehler: "json" }, 400); }
  const frage = kurz(x.frage, 600).trim(), kontext = kurz(x.kontext, 80000);
  if (!frage) return chatJson({ fehler: "leer" }, 400);
  const verlauf = (Array.isArray(x.verlauf) ? x.verlauf : []).slice(-6)
    .filter(m => (m.rolle === "user" || m.rolle === "assistant") && typeof m.text === "string")
    .map(m => ({ role: m.rolle, content: m.text.slice(0, 1500) }));
  while (verlauf.length && verlauf[0].role !== "user") verlauf.shift();
  const tag = new Date().toISOString().slice(0, 10);
  const z = await zaehlen(env, req.headers.get("cf-connecting-ip") || "?", tag);
  if (!z.ok) return chatJson({ fehler: "limit", grund: z.grund }, 429);
  const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: env.CHAT_MODELL || CHAT_MODELL, max_tokens: 600,
      system: SYSTEM + "\n\n<vereinsdaten>\n" + kontext + "\n</vereinsdaten>",
      messages: [...verlauf, { role: "user", content: frage }] }) });
  if (!r.ok) { console.log("Anthropic", r.status, (await r.text()).slice(0, 300)); return chatJson({ fehler: "ki", status: r.status }, 502); }
  const j = await r.json();
  const antwort = (j.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
  return chatJson({ antwort, rest: z.rest });
}

// ---------------------------------------------------------------- Live-Stand von SportEasy (nur Jugend)
// SportEasy hat keine offizielle Schnittstelle. Der Worker meldet sich mit dem App-Konto an (Secrets SE_USER, SE_PASSWORD),
// holt die heutigen Spiele einer Jugendkategorie samt eingetragener Tore und gibt nur Mannschaften, Spielstand,
// Torminuten und bei FCJJ-Toren den Vornamen der Torschützin/des Torschützen weiter (kein Nachname, keine Gegnernamen;
// vom Verein, 17.11.2026) — keine Anwesenheiten oder Nachrichten. Antworten werden 60 s zwischengespeichert.
const SE_API = "https://api.sporteasy.net";
const SE_TEAMS = { U7: 3783742, U9: 3783744, U11: 3783745, U13: 3783746, U15: 3783747, U17: 3783765, U19: 3783766,
  WU11: 3783752, WU13: 3783759, WU15: 3783764 };
const SE_KOPF = { accept: "application/json", "user-agent": "Mozilla/5.0 (FCJJ-App)",
  origin: "https://app.sporteasy.net", referer: "https://app.sporteasy.net/" };
const liveCors = { "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "GET, OPTIONS", "access-control-max-age": "86400" };
const liveJson = (x, status = 200, max = 0) => new Response(JSON.stringify(x), { status,
  headers: { ...liveCors, "content-type": "application/json", "cache-control": `public, max-age=${max}` } });
const lxTag = d => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Luxembourg" }).format(d);

function keksAus(res, alt = "") {
  const m = new Map(alt.split("; ").filter(Boolean).map(k => [k.split("=")[0], k]));
  const liste = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get("set-cookie") || "").split(/,(?=\s*[^;,=\s]+=)/);
  for (const c of liste) { const p = c.split(";")[0].trim(); if (p.includes("=")) m.set(p.split("=")[0], p); }
  return [...m.values()].join("; ");
}
const keksWert = (keks, name) => (keks.split("; ").find(k => k.startsWith(name + "=")) || "").slice(name.length + 1);

async function seAnmelden(env) {
  const c = await fetch(SE_API + "/v2.1/account/csrf/", { headers: SE_KOPF });
  let keks = keksAus(c), csrf = keksWert(keks, "csrftoken");
  try { const j = await c.json(); csrf = csrf || j.csrftoken || j.csrf_token || j.token || ""; } catch (e) {}
  const r = await fetch(SE_API + "/v2.1/account/authenticate/", { method: "POST",
    headers: { ...SE_KOPF, "content-type": "application/json", "x-csrftoken": csrf, cookie: keks },
    body: JSON.stringify({ username: env.SE_USER, password: env.SE_PASSWORD }) });
  keks = keksAus(r, keks);
  let token = "";
  try { const j = await r.json(); token = j.token || j.access_token || j.key || ""; } catch (e) {}
  console.log("SportEasy-Anmeldung:", r.status);
  if (!r.ok) return null;
  const sitzung = { keks, token };
  SE_SITZUNG = sitzung;
  if (env.PUSH) await env.PUSH.put("se:sitzung", JSON.stringify(sitzung), { expirationTtl: 6 * 3600 });
  return sitzung;
}
let SE_SITZUNG = null;   // Anmeldung im Speicher (und in KV, damit nicht jeder Worker neu anmeldet)
async function seHolen(env, pfad) {
  let s = SE_SITZUNG;
  if (!s && env.PUSH) try { s = JSON.parse(await env.PUSH.get("se:sitzung")); } catch (e) {}
  for (let versuch = 0; versuch < 2; versuch++) {
    if (!s) s = await seAnmelden(env);
    if (!s) return { status: 401, j: null };
    const h = { ...SE_KOPF, cookie: s.keks };
    if (s.token && !s.keks.includes("sessionid=")) h.authorization = "Token " + s.token;
    const r = await fetch(SE_API + pfad, { headers: h });
    if (r.status === 401 || r.status === 403) { s = SE_SITZUNG = null; if (env.PUSH) await env.PUSH.delete("se:sitzung"); continue; }
    return { status: r.status, j: r.ok ? await r.json() : null };
  }
  return { status: 401, j: null };
}
export async function live(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: liveCors });
  const kat = new URL(req.url).searchParams.get("kat") || "", team = SE_TEAMS[kat];
  if (!team) return liveJson({ fehler: "kat" }, 400);
  if (!env.SE_USER || !env.SE_PASSWORD) return liveJson({ fehler: "aus" }, 503, 300);
  const cache = caches.default, schluessel = new Request(`https://fcjj-live.intern/${kat}`);
  const alt = await cache.match(schluessel);
  if (alt) return alt;
  const liste = await seHolen(env, `/v2.1/teams/${team}/events/`);
  if (!liste.j) return liveJson({ fehler: "sporteasy", status: liste.status }, 502, 30);
  const ln = await seHolen(env, `/v2.1/teams/${team}/events/last-next/`);
  const alle = new Map();
  for (const e of [...(liste.j.results || []), ln.j?.last_event, ln.j?.next_event]) if (e?.id) alle.set(e.id, e);
  const heute = lxTag(new Date()), spiele = [];
  // „is_current_team“ fehlt bei Spielen, die ein anderes FCJJ-Team angelegt hat → FCJJ auch am Namen erkennen (21.11.2026).
  const seite = x => ({ n: x.full_name || x.short_name || "", tore: x.score == null || x.score === "" ? null : +x.score, wir: !!x.is_current_team || /junglinster/i.test(x.full_name || x.short_name || ""), heim: !!x.is_home });
  for (const e of alle.values()) {
    if (!e.opponent_left || !e.opponent_right || e.is_cancelled || lxTag(new Date(e.start_at)) !== heute) continue;
    const sp = { start: e.start_at, links: seite(e.opponent_left), rechts: seite(e.opponent_right), tore: [] };
    const ls = await seHolen(env, `/v2.1/teams/${team}/events/${e.id}/live-stats/events/`);
    // Alle Live-Aktionen (vom Verein, 22.11.2026): Art, Zeit (Sekunden), Seite, „verfehlt“ und bei FCJJ nur Vornamen
    // (Spieler und, falls vorhanden, zweite Person wie Vorlage oder Einwechslung). Tore zusätzlich wie bisher in „tore“.
    const vorname = p => p?.first_name ? String(p.first_name).trim().split(/\s+/)[0].slice(0, 20) : null;
    sp.aktionen = [];
    for (const a of ls.j?.results || []) {
      if (!a?.action_slug_name) continue;
      const s = a.opponent === "opponent_left" ? "links" : a.opponent === "opponent_right" ? "rechts" : null, wir = s && sp[s].wir;
      const zweit = a.related_profile || a.second_profile || a.assist_profile || a.profile_in || null;
      sp.aktionen.push({ typ: String(a.action_slug_name).slice(0, 60), min: a.time ?? null, halb: a.period ?? null, seite: s,
        verfehlt: !!a.is_missed, name: wir ? vorname(a.profile) : null, name2: wir ? vorname(zweit) : null });
      if (a.action_slug_name === "football_goal" && !a.is_missed) sp.tore.push({ min: a.time ?? null, halb: a.period ?? null, seite: s, name: wir ? vorname(a.profile) : null });
    }
    const zeit = (a, b) => (a.halb ?? 0) - (b.halb ?? 0) || (a.min ?? 0) - (b.min ?? 0);
    sp.tore.sort(zeit); sp.aktionen.sort(zeit);
    // Nur die Feldnamen (keine Werte), damit man neue Aktionsarten und Felder erkennen kann.
    sp.felder = [...new Set((ls.j?.results || []).flatMap(x => Object.keys(x || {})))].slice(0, 40);
    spiele.push(sp);
  }
  const antwort = liveJson({ stand: new Date().toISOString(), spiele }, 200, 60);
  await cache.put(schluessel, antwort.clone());
  return antwort;
}

// ---------------------------------------------------------------- Buvette-Hilfe (vom Verein, 20.11.2026)
// Eltern tragen sich in der App für eine Buvette-Schicht bei Heimspielen der Jugend ein (mindestens 1, ideal 2 Personen).
// Öffentlich sieht man nur, wie viele Plätze belegt sind; Namen und Telefon sieht nur der Verein unter
// /buvette/liste?key=<BUVETTE_KEY> (Secret im Worker). Speicher: KV-Binding PUSH, Schlüssel buvette:<Schicht-ID>.
const BUVETTE_MAX = 2, BUVETTE_MAX_SEN = 3, BUVETTE_PRO_TAG = 8;   // Seniors/Réserves: 3 Personen (23.11.2026)
const bMax = id => String(id).endsWith("s") ? BUVETTE_MAX_SEN : /[re]$/.test(String(id)) ? 1 : BUVETTE_MAX;   // Réserves, SCO, CAD, JUN, WU15: 1 Person
const DATEN_URL = "https://fcjeunessejunglinster.github.io/fcjj/data/fussball.json";
const bCors = { "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const bJson = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { ...bCors, "content-type": "application/json", "cache-control": "no-store" } });
const sha = async x => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(x)))].map(b => b.toString(16).padStart(2, "0")).join("");
const htmlEsc = x => String(x ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Buvette-Schichten aus den App-Daten (gleicher Code in index.html und im Worker):
// Heimspiele der Jugend in Junglinster, je Anstoßzeit eine Schicht: 30 min vor dem Anstoß bis 30 min nach dem
// Spielende, das Ende auf :00/:15/:30/:45 abgerundet, also nie später als 30 min nach dem Spiel (vom Verein, 23.11.2026). Schicht-ID: JJJJMMTT-HHMM.
// SEN/RES: Seniors und Réserves in einem eigenen Abschnitt, Schicht-ID mit „s“ (Seniors, 3 Personen), „r“ (Réserves, 1) oder „e“ (SCO/CAD/JUN/WU15, 1) am Ende (vom Verein, 23.11.2026).
const BUVETTE_DAUER = { U7: 60, U9: 90, U11: 75, WU11: 75, U13: 85, WU13: 60, U15: 85, WU15: 85, U17: 95, U19: 105, SEN: 105, RES: 105 };
function buvetteSchichten(d, ab = Date.now()) {
  const lx = t => Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Luxembourg", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  const team = new Map();
  for (const t of d.teams || []) if (BUVETTE_DAUER[t.kat]) for (const id of [...t.ids, ...(t.mit || [])]) team.set(id, t);
  const tage = new Map();
  for (const k of Object.values(d.klassen || {})) for (const sp of k.spiele || []) {
    const t = team.get(sp.h.id), an = Date.parse(sp.d);
    if (!t || (sp.ort && !/Junglinster/i.test(sp.ort)) || an + BUVETTE_DAUER[t.kat] * 6e4 + 18e5 < ab) continue;
    const p = lx(an), sen = t.kat === "SEN" || t.kat === "RES", zus = t.kat === "RES" ? "r" : sen ? "s" : ["U15", "U17", "U19", "WU15"].includes(t.kat) ? "e" : "", tag = p.year + p.month + p.day, gruppe = tag + zus;
    if (+p.hour < 6) continue;   // Anstoß vor 6 Uhr = Uhrzeit noch nicht festgelegt: erst eintragbar, wenn die FLF die Zeit hat
    if (!tage.has(gruppe)) tage.set(gruppe, []);
    tage.get(gruppe).push({ an, ende: an + BUVETTE_DAUER[t.kat] * 6e4, id: tag + "-" + p.hour + p.minute + zus, sen, team: t.reiter, gegner: sp.a.n, h: sp.h, a: sp.a, ort: sp.ort || "" });
  }
  const aus = [];
  for (const liste of tage.values()) {
    liste.sort((a, b) => a.an - b.an);
    const bloecke = [];
    for (const s of liste) { const b = bloecke[bloecke.length - 1]; if (b && b.an === s.an) b.spiele.push(s); else bloecke.push({ id: s.id, an: s.an, spiele: [s] }); }
    // Jede Schicht: 30 min vor dem Anstoß bis 30 min nach dem Spielende (vom Verein, 23.11.2026).
    for (const b of bloecke) aus.push({ id: b.id, von: b.an - 18e5, bis: Math.floor((Math.max(...b.spiele.map(s => s.ende)) + (b.spiele[0].sen ? 36e5 : 18e5)) / 9e5) * 9e5,   // Seniors: 1 Std. nach Spielende (23.11.2026)   // höchstens 30 min nach Spielende, auf die Viertelstunde abgerundet
      sen: b.spiele[0].sen, spiele: b.spiele.map(s => ({ team: s.team, gegner: s.gegner, h: s.h, a: s.a })), ort: b.spiele[0].ort });
  }
  return aus.filter(s => s.bis > ab).sort((a, b) => a.von - b.von);
}
async function buvetteSchicht(id) {
  const r = await fetch(DATEN_URL, { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!r.ok) return null;
  return buvetteSchichten(await r.json()).find(x => x.id === id) || null;
}
// Mail an den Verein bei jeder Ein- und Austragung (vom Verein, 20.11.2026), über Resend (resend.com, kostenlos):
// Secret RESEND_API_KEY. Ohne eigene Domain darf Resend nur an die Adresse schicken, mit der das Konto angelegt wurde
// → das Konto mit BUVETTE_MAIL anlegen. Mit bestätigter Domain fcjj.lu kann RESEND_FROM z. B. buvette@fcjj.lu sein.
const BUVETTE_MAIL = "gilles.emeringer@fcjj.lu";
async function buvMail(env, betreff, zeilen) {
  if (!env.RESEND_API_KEY) return;
  try {
    const r = await fetch("https://api.resend.com/emails", { method: "POST",
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.RESEND_FROM || "FCJJ Buvette <onboarding@resend.dev>", to: [env.BUVETTE_MAIL || BUVETTE_MAIL], subject: betreff,
        html: `<div style="font:15px system-ui,sans-serif">${zeilen.map(z => `<p style="margin:0 0 8px">${z}</p>`).join("")}</div>` }) });
    if (!r.ok) console.log("Resend", r.status, (await r.text()).slice(0, 200));
  } catch (e) { console.log("Resend", e.message); }
}
const schichtText = sp => {
  const z = (d, o) => new Date(d).toLocaleString("de-DE", { timeZone: "Europe/Luxembourg", ...o });
  return `${z(sp.von, { weekday: "short", day: "numeric", month: "numeric" })} ${z(sp.von, { hour: "2-digit", minute: "2-digit" })}–${z(sp.bis, { hour: "2-digit", minute: "2-digit" })}`;
};
const bLaden = async (env, id) => { try { return JSON.parse(await env.PUSH.get("buvette:" + id)) || null; } catch (e) { return null; } };

export async function buvette(req, env, pfad) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: bCors });
  if (!env.PUSH) return bJson({ fehler: "aus" }, 503);
  const url = new URL(req.url);
  if (pfad === "/buvette/liste") return buvetteListe(env, url);
  if (req.method === "GET") {   // Belegung: ?ids=1,2,3 → { "1": 1, "2": 0 … }
    const ids = (url.searchParams.get("ids") || "").split(",").filter(x => /^\d{8}-\d{4}[sre]?$/.test(x)).slice(0, 80);
    const aus = {};
    await Promise.all(ids.map(async id => { aus[id] = (await bLaden(env, id))?.leute?.length || 0; }));
    return bJson({ belegt: aus, max: BUVETTE_MAX, maxSen: BUVETTE_MAX_SEN });
  }
  if (req.method !== "POST") return bJson({ fehler: "methode" }, 405);
  if ((req.headers.get("origin") || "") !== ORIGIN) return bJson({ fehler: "herkunft" }, 403);
  let x; try { x = await req.json(); } catch (e) { return bJson({ fehler: "json" }, 400); }
  const id = String(x.id || "");
  if (!/^\d{8}-\d{4}[sre]?$/.test(id)) return bJson({ fehler: "spiel" }, 400);
  const eintrag = (await bLaden(env, id)) || { leute: [] };
  if (x.aktion === "ab") {   // Austragen mit dem Schlüssel, den nur das eigene Handy kennt
    const h = await sha(String(x.token || ""));
    const vorher = eintrag.leute.length;
    const weg = eintrag.leute.find(l => l.h === h);
    eintrag.leute = eintrag.leute.filter(l => l.h !== h);
    if (eintrag.leute.length === vorher) return bJson({ fehler: "token" }, 404);
    await env.PUSH.put("buvette:" + id, JSON.stringify(eintrag), { expirationTtl: 60 * 864e2 });
    if (eintrag.spiel) await buvMail(env, `Buvette: Austragung ${schichtText(eintrag.spiel)} (${eintrag.leute.length}/${bMax(id)})`, [
      `❌ <b>${htmlEsc(weg.name)}</b> hat sich ausgetragen.`, `<b>${htmlEsc(schichtText(eintrag.spiel))}</b><br>${eintrag.spiel.spiele.map(x => `${htmlEsc(x.team)} – ${htmlEsc(x.gegner)}`).join("<br>")}`,
      `Jetzt belegt: ${eintrag.leute.length}/${bMax(id)}${eintrag.leute.length ? " (" + eintrag.leute.map(l => htmlEsc(l.name)).join(", ") + ")" : " – <b>niemand mehr eingetragen</b>"}`]);
    return bJson({ ok: true, belegt: eintrag.leute.length });
  }
  const name = String(x.name || "").trim().slice(0, 60), tel = String(x.tel || "").trim().slice(0, 30), notiz = String(x.notiz || "").trim().slice(0, 120);
  if (name.length < 3 || !/\d{6,}/.test(tel.replace(/\D/g, "") ) ) return bJson({ fehler: "daten" }, 400);
  const sp = await buvetteSchicht(id);
  if (!sp) return bJson({ fehler: "spiel" }, 400);
  if (eintrag.leute.length >= bMax(id)) return bJson({ fehler: "voll", belegt: eintrag.leute.length }, 409);
  // Tageslimit je Anschluss gegen Unfug
  const tag = new Date().toISOString().slice(0, 10), ip = await sha((req.headers.get("cf-connecting-ip") || "?") + "fcjj");
  const kIp = `bulimit:${tag}:${ip.slice(0, 16)}`, n = +(await env.PUSH.get(kIp)) || 0;
  if (n >= BUVETTE_PRO_TAG) return bJson({ fehler: "limit" }, 429);
  await env.PUSH.put(kIp, String(n + 1), { expirationTtl: 172800 });
  const token = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
  eintrag.spiel = sp;
  eintrag.leute.push({ name, tel, notiz, t: new Date().toISOString(), h: await sha(token) });
  const bis = Math.max(86400, Math.round((sp.bis - Date.now()) / 1000) + 30 * 86400);
  await env.PUSH.put("buvette:" + id, JSON.stringify(eintrag), { expirationTtl: bis });
  await buvMail(env, `Buvette: ${name} – ${schichtText(sp)} (${eintrag.leute.length}/${bMax(id)})`, [
    `✅ Neue Eintragung für die Buvette:`, `<b>${htmlEsc(name)}</b> · <a href="tel:${htmlEsc(tel.replace(/[^\d+]/g, ""))}">${htmlEsc(tel)}</a>${notiz ? `<br><i>${htmlEsc(notiz)}</i>` : ""}`,
    `<b>${htmlEsc(schichtText(sp))}</b> · ${htmlEsc(sp.ort)}<br>${sp.spiele.map(x => `${htmlEsc(x.team)} – ${htmlEsc(x.gegner)}`).join("<br>")}`,
    `Jetzt belegt: ${eintrag.leute.length}/${bMax(id)} (${eintrag.leute.map(l => htmlEsc(l.name)).join(", ")})`]);
  return bJson({ ok: true, token, belegt: eintrag.leute.length });
}

// Liste für den Verein (geschützt mit BUVETTE_KEY): alle kommenden Heimspiele mit Eintragungen.
async function buvetteListe(env, url) {
  if (!env.BUVETTE_KEY || url.searchParams.get("key") !== env.BUVETTE_KEY)
    return new Response("Kein Zugang.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  const schluessel = []; let cursor;
  do { const r = await env.PUSH.list({ prefix: "buvette:", cursor }); schluessel.push(...r.keys.map(k => k.name)); cursor = r.list_complete ? null : r.cursor; } while (cursor);
  const alle = (await Promise.all(schluessel.map(async k => { try { return JSON.parse(await env.PUSH.get(k)); } catch (e) { return null; } })))
    .filter(e => e?.spiel && e.leute?.length && e.spiel.bis > Date.now() - 864e5).sort((a, b) => a.spiel.von - b.spiel.von);
  const zeit = d => new Date(d).toLocaleString("de-DE", { timeZone: "Europe/Luxembourg", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
  const uhr = d => new Date(d).toLocaleTimeString("de-DE", { timeZone: "Europe/Luxembourg", hour: "2-digit", minute: "2-digit" });
  const zeilen = alle.map(e => `<tr><td>${htmlEsc(zeit(e.spiel.von))}–${htmlEsc(uhr(e.spiel.bis))}</td><td>${e.spiel.spiele.map(x => `<b>${htmlEsc(x.team)}</b> – ${htmlEsc(x.gegner)}`).join("<br>")}<br><small>${htmlEsc(e.spiel.ort)}</small></td><td>${e.leute.length}/${bMax(e.spiel.id)}</td><td>${e.leute.map(l => `${htmlEsc(l.name)} · <a href="tel:${htmlEsc(l.tel.replace(/[^\d+]/g, ""))}">${htmlEsc(l.tel)}</a>${l.notiz ? `<br><small>${htmlEsc(l.notiz)}</small>` : ""}`).join("<hr>")}</td></tr>`).join("");
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Buvette FCJJ</title>
<style>body{font:15px system-ui,sans-serif;margin:16px;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px 6px;text-align:left;vertical-align:top}hr{border:0;border-top:1px dashed #ccc;margin:4px 0}small{color:#666}</style>
<h1>🍺 Buvette – Eintragungen</h1><p>Nur Schichten mit mindestens einer Person. Schichten ohne Eintrag sieht man in der App („Hilfe gesucht“).</p>
<table><tr><th>Schicht</th><th>Spiele</th><th>Belegt</th><th>Helfer</th></tr>${zeilen || `<tr><td colspan="4">Noch keine Eintragungen.</td></tr>`}</table>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---------------------------------------------------------------- Nutzerzähler (vom Verein, 22.11.2026)
// Jedes Handy meldet sich höchstens einmal pro Tag (die App merkt sich den Tag). Gespeichert werden nur Summen je Tag:
// alle, installierte App/Browser, Sprache, Android/iPhone/andere — keine ID, keine IP, kein Cookie.
// Ansehen: /statistik?key=<BUVETTE_KEY>.
const zCors = { "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" };
export async function zaehler(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: zCors });
  if (req.method !== "POST" || !env.PUSH) return new Response(null, { status: 204, headers: zCors });
  if ((req.headers.get("origin") || "") !== ORIGIN) return new Response(null, { status: 403, headers: zCors });
  let x = {}; try { x = JSON.parse(await req.text()); } catch (e) {}
  const tag = lxTag(new Date()), key = "zahl:" + tag;
  let z = {}; try { z = JSON.parse(await env.PUSH.get(key)) || {}; } catch (e) {}
  const plus = k => { z[k] = (z[k] || 0) + 1; };
  plus("alle");
  plus(x.modus === "app" ? "app" : "web");
  plus(["de", "en", "fr"].includes(x.lang) ? x.lang : "andere_sprache");
  plus(["android", "ios"].includes(x.os) ? x.os : "andere");
  await env.PUSH.put(key, JSON.stringify(z), { expirationTtl: 400 * 86400 });
  return new Response(null, { status: 204, headers: zCors });
}
async function statistik(env, url) {
  if (!env.BUVETTE_KEY || url.searchParams.get("key") !== env.BUVETTE_KEY)
    return new Response("Kein Zugang.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
  const tage = Array.from({ length: 42 }, (_, i) => lxTag(new Date(Date.now() - i * 864e5)));
  const werte = await Promise.all(tage.map(async t => { try { return JSON.parse(await env.PUSH.get("zahl:" + t)) || {}; } catch (e) { return {}; } }));
  const max = Math.max(1, ...werte.map(w => w.alle || 0));
  const fmt = t => new Date(t + "T12:00:00Z").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "numeric" });
  const pct = (w, k) => w.alle ? Math.round(100 * (w[k] || 0) / w.alle) + " %" : "–";
  const zeilen = tage.map((t, i) => { const w = werte[i]; return `<tr><td>${fmt(t)}</td><td class="z"><b>${w.alle || 0}</b></td><td><div class="bar" style="width:${Math.round(100 * (w.alle || 0) / max)}%"></div></td><td class="z">${pct(w, "app")}</td><td class="z">${w.android || 0} / ${w.ios || 0} / ${w.andere || 0}</td><td class="z">${w.de || 0} / ${w.fr || 0} / ${w.en || 0}</td></tr>`; }).join("");
  const sum = n => werte.slice(0, n).reduce((a, w) => a + (w.alle || 0), 0);
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>FCJJ-App Statistik</title>
<style>body{font:15px system-ui,sans-serif;margin:16px;color:#111}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:6px;text-align:left;white-space:nowrap}.z{text-align:right}.bar{height:12px;background:#c8102e;border-radius:3px;min-width:2px}td:nth-child(3){width:40%}small{color:#666}</style>
<h1>📊 FCJJ-App: Nutzer pro Tag</h1><p>Heute: <b>${werte[0].alle || 0}</b> · letzte 7 Tage zusammen: <b>${sum(7)}</b> · letzte 30 Tage: <b>${sum(30)}</b><br><small>Jedes Handy zählt höchstens einmal pro Tag (wer die App an 3 Tagen öffnet, zählt in der Summe 3-mal). Keine persönlichen Daten.</small></p>
<table><tr><th>Tag</th><th class="z">Nutzer</th><th></th><th class="z">installiert</th><th class="z">Android / iPhone / andere</th><th class="z">DE / FR / EN</th></tr>${zeilen}</table>`,
    { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex" } });
}

// ---------------------------------------------------------------- Absagen aus SportEasy (vom Verein, 27.11.2026)
// Abgesagte Spiele (is_cancelled) aller Jugendkategorien in den nächsten 14 Tagen: nur Kategorie, Anstoß und die beiden
// Mannschaftsnamen. Die App ordnet sie den FLF-Spielen zu (gleicher Tag, Gegnername). 10 Minuten zwischengespeichert.
export async function absagen(req, env) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: liveCors });
  if (!env.SE_USER || !env.SE_PASSWORD) return liveJson({ fehler: "aus" }, 503, 300);
  const cache = caches.default, schluessel = new Request("https://fcjj-live.intern/absagen");
  const alt = await cache.match(schluessel);
  if (alt) return alt;
  const jetzt = Date.now(), bis = jetzt + 14 * 864e5, aus = [], ergebnisse = [];
  let fehler = 0;
  for (const [kat, team] of Object.entries(SE_TEAMS)) {
    const r = await seHolen(env, `/v2.1/teams/${team}/events/`);
    if (!r.j) { fehler++; continue; }
    const ln = await seHolen(env, `/v2.1/teams/${team}/events/last-next/`);   // auch das letzte Spiel, falls die Liste nur kommende hat
    const ev = new Map();
    for (const e of [...(r.j.results || []), ln.j?.last_event]) if (e?.id) ev.set(e.id, e);
    for (const e of ev.values()) {
      const t = Date.parse(e.start_at);
      // Ergebnisse der letzten 7 Tage (vom Verein, 28.11.2026): nur Spielstand, die App nimmt sie, solange die FLF keins hat.
      const tor = x => x?.score == null || x.score === "" ? null : +x.score;
      if (!e.is_cancelled && e.opponent_left && e.opponent_right && t < jetzt && t > jetzt - 7 * 864e5 && tor(e.opponent_left) != null && tor(e.opponent_right) != null)
        ergebnisse.push({ kat, start: e.start_at, links: e.opponent_left.full_name || e.opponent_left.short_name || "", rechts: e.opponent_right.full_name || e.opponent_right.short_name || "",
          tl: tor(e.opponent_left), tr: tor(e.opponent_right) });
      if (!e.is_cancelled || !e.opponent_left || !e.opponent_right || !(t > jetzt - 864e5 && t < bis)) continue;
      aus.push({ kat, start: e.start_at, links: e.opponent_left.full_name || e.opponent_left.short_name || "", rechts: e.opponent_right.full_name || e.opponent_right.short_name || "" });
    }
  }
  const antwort = liveJson({ stand: new Date().toISOString(), absagen: aus, ergebnisse, fehler }, 200, 600);
  if (!fehler) await cache.put(schluessel, antwort.clone());
  return antwort;
}

// ---------------------------------------------------------------- Freitags-Mail: offene Buvette-Schichten (vom Verein, 28.11.2026)
// WhatsApp erlaubt kein automatisches Posten in Gruppen. Deshalb kommt jeden Freitag um 20:00 eine Mail an BUVETTE_MAIL mit
// der fertigen Nachricht und einem Knopf, der WhatsApp mit dem Text öffnet (Gruppe wählen, senden). Zeitraum: nächste 7 Tage.
const APP_URL = "https://fcjeunessejunglinster.github.io/fcjj/";
export function buvWhatsappText(offen) {
  const z = (d, o) => new Date(d).toLocaleString("fr-FR", { timeZone: "Europe/Luxembourg", ...o });
  const zeilen = offen.map(x => `• ${z(x.von, { weekday: "short", day: "numeric", month: "numeric" })} ${z(x.von, { hour: "2-digit", minute: "2-digit" })}–${z(x.bis, { hour: "2-digit", minute: "2-digit" })} · ${x.spiele.map(g => g.team).join(" + ")} · ${x.n}/${x.max}`);
  return `☕️ *Buvette – on cherche encore de l'aide !*\n\n${zeilen.join("\n")}\n\nInscription en 1 clic dans l'app (onglet « Buvette Help ») :\n${APP_URL}\n\nMerci à tous pour votre soutien ⚪️🔴⚫️`;
}
async function buvFreitagsMail(env, sofort = false) {
  if (!env.PUSH || !env.RESEND_API_KEY) return;
  const tag = lxTag(new Date()), merkKey = "buvfreitag:" + tag;
  if (!sofort) {
    if (await env.PUSH.get(merkKey)) return;
    await env.PUSH.put(merkKey, "1", { expirationTtl: 3 * 86400 });
  }
  const r = await fetch(DATEN_URL, { cf: { cacheTtl: 300, cacheEverything: true } }); if (!r.ok) return;
  const jetzt = Date.now(), alle = buvetteSchichten(await r.json(), jetzt).filter(x => x.von < jetzt + 7 * 864e5);
  const offen = [];
  for (const x of alle) { const n = (await bLaden(env, x.id))?.leute?.length || 0, max = bMax(x.id); if (n < max) offen.push({ ...x, n, max }); }
  if (!offen.length) { await buvMail(env, "Buvette: alle Schichten der nächsten 7 Tage sind besetzt 🎉", ["Keine offenen Schichten – nichts zu posten."]); return; }
  const text = buvWhatsappText(offen), wa = "https://wa.me/?text=" + encodeURIComponent(text);
  await buvMail(env, `Buvette: ${offen.length} offene Schicht${offen.length > 1 ? "en" : ""} – Nachricht für WhatsApp`, [
    `Hier die offenen Buvette-Schichten der nächsten 7 Tage. Auf dem Handy auf den Knopf tippen, die Gruppe „FC Jeunesse Junglinster Parents“ wählen und senden:`,
    `<a href="${wa}" style="display:inline-block;background:#1f8f4e;color:#fff;padding:12px 18px;border-radius:10px;text-decoration:none;font-weight:700">💬 In WhatsApp öffnen</a>`,
    `<pre style="white-space:pre-wrap;font:14px system-ui,sans-serif;background:#f4f4f4;padding:12px;border-radius:8px">${htmlEsc(text)}</pre>`]);
}

export default {
  async scheduled(event, env, ctx) {
    if (abrufFaellig(new Date(event.scheduledTime))) ctx.waitUntil(anstossen(env));
    const o = ortszeit(new Date(event.scheduledTime));
    if (o.tag === 5 && o.std === 20 && o.min < 15) ctx.waitUntil(buvFreitagsMail(env));   // Freitag 20:00
  },
  // Statusseite (verrät nichts Geheimes, stößt nichts an).
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/frage") return chat(req, env);
    const pfad = new URL(req.url).pathname;
    // Mail mit den offenen Schichten sofort schicken: /buvette/mail?key=<BUVETTE_KEY> (vom Verein, 28.11.2026)
    if (pfad === "/buvette/mail") {
      const u = new URL(req.url);
      if (!env.BUVETTE_KEY || u.searchParams.get("key") !== env.BUVETTE_KEY) return new Response("Kein Zugang.", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
      await buvFreitagsMail(env, true);
      return new Response("Mail mit den offenen Buvette-Schichten ist verschickt ✓", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (pfad === "/buvette" || pfad === "/buvette/liste") return buvette(req, env, pfad);
    if (pfad === "/zaehler") return zaehler(req, env);
    if (pfad === "/statistik") return statistik(env, new URL(req.url));
    if (new URL(req.url).pathname === "/live") return live(req, env);
    if (new URL(req.url).pathname === "/absagen") return absagen(req, env);
    const jetzt = new Date();
    let naechster = null;
    for (let t = Math.ceil(jetzt / 9e5) * 9e5, i = 0; i < 4 * 24 * 8; t += 9e5, i++) if (abrufFaellig(new Date(t))) { naechster = new Date(t); break; }
    const zeit = d => d.toLocaleString("de-DE", { timeZone: "Europe/Luxembourg", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
    return new Response(`FCJJ-App: Abruf-Anstoß, Chat und SportEasy-Live\n\nToken: ${env.GITHUB_TOKEN ? "vorhanden ✓" : "FEHLT ✗"}\nChat (ANTHROPIC_API_KEY): ${env.ANTHROPIC_API_KEY ? "vorhanden ✓" : "FEHLT ✗"}\nTageslimits (KV PUSH): ${env.PUSH ? "verbunden ✓" : "FEHLT ✗"}\nBuvette-Liste (BUVETTE_KEY): ${env.BUVETTE_KEY ? "vorhanden ✓" : "FEHLT ✗"}\nBuvette-Mails (RESEND_API_KEY): ${env.RESEND_API_KEY ? "vorhanden ✓" : "FEHLT ✗"}\nSportEasy-Live (SE_USER, SE_PASSWORD): ${env.SE_USER && env.SE_PASSWORD ? "vorhanden ✓" : "FEHLT ✗"}\nNächster Anstoß: ${naechster ? zeit(naechster) : "–"}\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
