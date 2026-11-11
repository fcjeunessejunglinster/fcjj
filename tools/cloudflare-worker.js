// Cloudflare Worker „fcjj“: stößt den FLF-Abruf auf GitHub pünktlich an.
// GitHub lässt geplante Läufe oft aus oder startet sie spät; Cloudflare läuft pünktlich (Cron jede Viertelstunde)
// und startet den Workflow per workflow_dispatch. GitHubs eigener Zeitplan bleibt als Reserve.
//
// Einrichten (einmalig):
//  - Worker anlegen, diesen Code einfügen, Deploy.
//  - Settings → Variables and Secrets → Secret GITHUB_TOKEN (Fine-grained Token, nur Repo fcjj, Actions: Read and write).
//  - Settings → Trigger Events → Cron Trigger „*/15 * * * *“.
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
  const frage = kurz(x.frage, 600).trim(), kontext = kurz(x.kontext, 40000);
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

export default {
  async scheduled(event, env, ctx) {
    if (abrufFaellig(new Date(event.scheduledTime))) ctx.waitUntil(anstossen(env));
  },
  // Statusseite (verrät nichts Geheimes, stößt nichts an).
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/frage") return chat(req, env);
    const jetzt = new Date();
    let naechster = null;
    for (let t = Math.ceil(jetzt / 9e5) * 9e5, i = 0; i < 4 * 24 * 8; t += 9e5, i++) if (abrufFaellig(new Date(t))) { naechster = new Date(t); break; }
    const zeit = d => d.toLocaleString("de-DE", { timeZone: "Europe/Luxembourg", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
    return new Response(`FCJJ-App: Abruf-Anstoß und Chat\n\nToken: ${env.GITHUB_TOKEN ? "vorhanden ✓" : "FEHLT ✗"}\nChat (ANTHROPIC_API_KEY): ${env.ANTHROPIC_API_KEY ? "vorhanden ✓" : "FEHLT ✗"}\nTageslimits (KV PUSH): ${env.PUSH ? "verbunden ✓" : "FEHLT ✗"}\nNächster Anstoß: ${naechster ? zeit(naechster) : "–"}\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
