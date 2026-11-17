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
  const seite = x => ({ n: x.full_name || x.short_name || "", tore: x.score == null || x.score === "" ? null : +x.score, wir: !!x.is_current_team, heim: !!x.is_home });
  for (const e of alle.values()) {
    if (!e.opponent_left || !e.opponent_right || e.is_cancelled || lxTag(new Date(e.start_at)) !== heute) continue;
    const sp = { start: e.start_at, links: seite(e.opponent_left), rechts: seite(e.opponent_right), tore: [] };
    const ls = await seHolen(env, `/v2.1/teams/${team}/events/${e.id}/live-stats/events/`);
    for (const a of ls.j?.results || []) if (a.action_slug_name === "football_goal" && !a.is_missed) {
      const s = a.opponent === "opponent_left" ? "links" : "rechts", wir = sp[s].wir;
      const name = wir && a.profile?.first_name ? String(a.profile.first_name).trim().split(/\s+/)[0].slice(0, 20) : null;
      sp.tore.push({ min: a.time ?? null, halb: a.period ?? null, seite: s, name });
    }
    sp.tore.sort((a, b) => (a.halb ?? 0) - (b.halb ?? 0) || (a.min ?? 0) - (b.min ?? 0));
    spiele.push(sp);
  }
  const antwort = liveJson({ stand: new Date().toISOString(), spiele }, 200, 60);
  await cache.put(schluessel, antwort.clone());
  return antwort;
}

export default {
  async scheduled(event, env, ctx) {
    if (abrufFaellig(new Date(event.scheduledTime))) ctx.waitUntil(anstossen(env));
  },
  // Statusseite (verrät nichts Geheimes, stößt nichts an).
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/frage") return chat(req, env);
    if (new URL(req.url).pathname === "/live") return live(req, env);
    const jetzt = new Date();
    let naechster = null;
    for (let t = Math.ceil(jetzt / 9e5) * 9e5, i = 0; i < 4 * 24 * 8; t += 9e5, i++) if (abrufFaellig(new Date(t))) { naechster = new Date(t); break; }
    const zeit = d => d.toLocaleString("de-DE", { timeZone: "Europe/Luxembourg", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
    return new Response(`FCJJ-App: Abruf-Anstoß, Chat und SportEasy-Live\n\nToken: ${env.GITHUB_TOKEN ? "vorhanden ✓" : "FEHLT ✗"}\nChat (ANTHROPIC_API_KEY): ${env.ANTHROPIC_API_KEY ? "vorhanden ✓" : "FEHLT ✗"}\nTageslimits (KV PUSH): ${env.PUSH ? "verbunden ✓" : "FEHLT ✗"}\nSportEasy-Live (SE_USER, SE_PASSWORD): ${env.SE_USER && env.SE_PASSWORD ? "vorhanden ✓" : "FEHLT ✗"}\nNächster Anstoß: ${naechster ? zeit(naechster) : "–"}\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
