// Cloudflare Worker „fcjj“: stößt den FLF-Abruf auf GitHub pünktlich an.
// GitHub lässt geplante Läufe oft aus oder startet sie spät; Cloudflare läuft pünktlich (Cron jede Viertelstunde)
// und startet den Workflow per workflow_dispatch. GitHubs eigener Zeitplan bleibt als Reserve.
// Idee wie in der Koeppchen-App (Plan B).
//
// Einrichten (einmalig):
//  - Worker anlegen, diesen Code einfügen, Deploy.
//  - Settings → Variables and Secrets → Secret GITHUB_TOKEN (Fine-grained Token, nur Repo fcjj, Actions: Read and write).
//  - Settings → Trigger Events → Cron Trigger „*/15 * * * *“.
// Prüfen: Adresse des Workers im Browser öffnen → zeigt, ob das Token da ist und wann der nächste Anstoß ist.

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

export default {
  async scheduled(event, env, ctx) {
    if (abrufFaellig(new Date(event.scheduledTime))) ctx.waitUntil(anstossen(env));
  },
  // Statusseite (verrät nichts Geheimes, stößt nichts an).
  async fetch(req, env) {
    const jetzt = new Date();
    let naechster = null;
    for (let t = Math.ceil(jetzt / 9e5) * 9e5, i = 0; i < 4 * 24 * 8; t += 9e5, i++) if (abrufFaellig(new Date(t))) { naechster = new Date(t); break; }
    const zeit = d => d.toLocaleString("de-DE", { timeZone: "Europe/Luxembourg", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
    return new Response(`FCJJ-App: Abruf-Anstoß\n\nToken: ${env.GITHUB_TOKEN ? "vorhanden ✓" : "FEHLT ✗"}\nNächster Anstoß: ${naechster ? zeit(naechster) : "–"}\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
