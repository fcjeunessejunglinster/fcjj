// Cloudflare Worker „fcjj“: stößt den FLF-Abruf auf GitHub pünktlich an und verschickt die Push-Mitteilungen der App.
//
// 1) Abruf: GitHub lässt geplante Läufe oft aus oder startet sie spät; Cloudflare läuft pünktlich und startet
//    den Workflow per workflow_dispatch. GitHubs eigener Zeitplan bleibt als Reserve.
// 2) Push: Der Abruf auf GitHub schreibt data/meldungen.json (neues Ergebnis, Verlegung, „Morgen Spieltag“).
//    Der Worker liest die Datei jede Minute, schickt neue Meldungen an alle, die die Mannschaft abonniert haben,
//    und merkt sich, was schon verschickt ist. Web Push (RFC 8291/8292) ohne Fremdbibliothek, nur WebCrypto.
//    Die VAPID-Schlüssel erzeugt der Worker beim ersten Lauf selbst und legt sie im KV-Speicher ab.
//
// Einrichten (einmalig):
//  - Worker anlegen, diesen Code einfügen, Deploy.
//  - Secret GITHUB_TOKEN (Fine-grained Token, nur Repo fcjj, Actions: Read and write).
//  - KV-Speicher „fcjj-push“ anlegen und als Binding mit dem Namen PUSH verbinden.
//  - Cron Trigger „* * * * *“ (jede Minute; der Abruf wird trotzdem nur zu den Zeiten unten angestoßen).
// Prüfen: Adresse des Workers im Browser öffnen → zeigt Token, Push-Speicher, Anmeldungen und den nächsten Anstoß.

const REPO = "fcjeunessejunglinster/fcjj";
const WORKFLOW = "abruf.yml";
const APP = "https://fcjeunessejunglinster.github.io/fcjj/";
const MELDUNGEN = APP + "data/meldungen.json";
const ORIGIN = "https://fcjeunessejunglinster.github.io";
const PRO_LAUF = 40;          // Free-Plan: höchstens 50 Anfragen nach außen je Lauf → Rest im nächsten Lauf

// Luxemburger Zeit (Sommer/Winter richtig) als {tag: 0=So … 6=Sa, std, min}.
function ortszeit(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Luxembourg", weekday: "short",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value]));
  return { tag: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday), std: +p.hour, min: +p.minute };
}

// Wann abrufen (Ortszeit, auf die Viertelstunde gerundet):
//  Sa/So 8:00–22:00 jede Viertelstunde (Spiele und Ergebnisse am Wochenende),
//  Mo–Fr 12:15 und 18:15–23:15 stündlich (Abendspiele, Veteranen montags, Nachträge der FLF),
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
// Bei Cron jede Minute nur in der ersten Minute jeder Viertelstunde anstoßen.
export const anstossJetzt = d => new Date(d).getUTCMinutes() % 15 === 0 && abrufFaellig(new Date(d));

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

// ---------------------------------------------------------------- Web Push
const te = new TextEncoder();
export const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const verbinden = (...teile) => { const n = teile.reduce((a, t) => a + t.length, 0), o = new Uint8Array(n); let i = 0; for (const t of teile) { o.set(t, i); i += t.length; } return o; };
async function hkdf(salt, ikm, info, laenge) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, laenge * 8));
}

// VAPID-Schlüssel aus dem KV-Speicher; beim allerersten Mal erzeugen (nur im Cron-Lauf, damit es keine zwei gibt).
async function vapid(env, erzeugen = false) {
  const j = await env.PUSH.get("vapid", "json");
  if (j) return j;
  if (!erzeugen) return null;
  const p = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const v = { priv: await crypto.subtle.exportKey("jwk", p.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", p.publicKey)) };
  await env.PUSH.put("vapid", JSON.stringify(v));
  return v;
}
async function vapidKopf(v, endpoint, cache) {
  const aud = new URL(endpoint).origin;
  if (cache[aud]) return cache[aud];
  const key = await crypto.subtle.importKey("jwk", v.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const kopf = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const inhalt = b64u(te.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 3600, sub: APP })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(kopf + "." + inhalt));
  return (cache[aud] = `vapid t=${kopf}.${inhalt}.${b64u(sig)}, k=${v.pub}`);
}
// Verschlüsseln nach RFC 8291 (aes128gcm). `eph` = eigenes ECDH-Schlüsselpaar (je Lauf eines; Salt ist je Nachricht neu).
export async function verschluesseln(sub, text, eph) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const geteilt = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const ikm = await hkdf(auth, geteilt, verbinden(te.encode("WebPush: info\0"), uaPub, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const klar = verbinden(te.encode(text), new Uint8Array([2]));
  const geheim = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, klar));
  const kopf = new Uint8Array(21); kopf.set(salt); new DataView(kopf.buffer).setUint32(16, 4096); kopf[20] = 65;
  return verbinden(kopf, asPub, geheim);
}
async function senden(sub, nachricht, v, eph, cache) {
  const body = await verschluesseln(sub, JSON.stringify(nachricht), eph);
  const r = await fetch(sub.endpoint, { method: "POST", body, headers: {
    authorization: await vapidKopf(v, sub.endpoint, cache), "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream", ttl: "86400", urgency: "normal" } });
  return r.status;
}

// ---------------------------------------------------------------- Anmeldungen
// Je Handy ein Schlüssel „abo:<Hash der Adresse>“; alles Nötige steht in den Metadaten (dann reicht ein list()).
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]*\.push\.apple\.com|[a-z0-9.-]*\.notify\.windows\.com|[a-z0-9.-]*\.push\.services\.mozilla\.com)$/;
const aboKey = async endpoint => "abo:" + b64u(await crypto.subtle.digest("SHA-256", te.encode(endpoint))).slice(0, 32);
export function aboPruefen(x) {
  const s = x?.sub, teams = x?.teams;
  if (!s || typeof s.endpoint !== "string" || s.endpoint.length > 600) return null;
  let u; try { u = new URL(s.endpoint); } catch (e) { return null; }
  if (u.protocol !== "https:" || !PUSH_HOSTS.test(u.hostname)) return null;
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(s.keys?.p256dh || "") || !/^[A-Za-z0-9_-]{16,32}$/.test(s.keys?.auth || "")) return null;
  if (!Array.isArray(teams) || teams.length > 40 || !teams.every(t => /^\w{1,20}$/.test(String(t)))) return null;
  return { e: s.endpoint, p: s.keys.p256dh, a: s.keys.auth, t: teams.map(String), l: ["de", "en", "fr"].includes(x.lang) ? x.lang : "de" };
}
async function alleAbos(env) {
  const aus = []; let cursor;
  do {
    const r = await env.PUSH.list({ prefix: "abo:", cursor });
    for (const k of r.keys) if (k.metadata) aus.push({ key: k.name, ...k.metadata });
    cursor = r.list_complete ? null : r.cursor;
  } while (cursor);
  return aus;
}

// ---------------------------------------------------------------- Meldungen verschicken
// Eine Meldung: { id, team, ab, bis, t: {de,en,fr}, b: {de,en,fr} } (Titel, Text). Mehrere für ein Handy → eine Mitteilung.
export function nachrichtFuer(abo, ev) {
  const l = abo.l || "de", m = ev.filter(e => abo.t.includes(String(e.team)));
  if (!m.length) return null;
  const tx = (o) => o[l] || o.de;
  if (m.length === 1) return { t: tx(m[0].t), b: tx(m[0].b), u: APP + "?reiter=" + m[0].team, tag: m[0].id };
  return { t: "FC Jeunesse Junglinster", b: m.slice(0, 4).map(e => tx(e.t).replace(/^FCJJ /, "") + ": " + tx(e.b)).join("\n"),
    u: APP + "?reiter=" + m[0].team, tag: "fcjj-" + m.map(e => e.id).join(",").slice(0, 60) };
}
export async function pushTakt(env, jetzt = Date.now()) {
  const v = await vapid(env, true);
  let job = await env.PUSH.get("job", "json");
  if (!job) {
    let daten;
    try {
      const r = await fetch(MELDUNGEN + "?t=" + Math.floor(jetzt / 6e4), { cf: { cacheTtl: 0 } });
      if (!r.ok) return "keine Meldungen (" + r.status + ")";
      daten = await r.json();
    } catch (e) { return "Meldungen nicht lesbar"; }
    const gesendet = (await env.PUSH.get("gesendet", "json")) || [];
    const faellig = (daten.ev || []).filter(e => Date.parse(e.ab) <= jetzt && jetzt < Date.parse(e.bis) && !gesendet.includes(e.id));
    if (!faellig.length) return "nichts Neues";
    await env.PUSH.put("gesendet", JSON.stringify([...faellig.map(e => e.id), ...gesendet].slice(0, 500)));
    job = { ev: faellig, fertig: [] };
  }
  const abos = await alleAbos(env);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  const cache = {}, fertig = new Set(job.fertig);
  let n = 0, weg = 0;
  for (const a of abos) {
    if (fertig.has(a.key)) continue;
    const nachricht = nachrichtFuer(a, job.ev);
    if (nachricht) {
      if (n >= PRO_LAUF) break;
      n++;
      try {
        const s = await senden({ endpoint: a.e, keys: { p256dh: a.p, auth: a.a } }, nachricht, v, eph, cache);
        if (s === 404 || s === 410) { await env.PUSH.delete(a.key); weg++; }
        else if (s >= 400) console.log("Push", s, new URL(a.e).hostname);
      } catch (e) { console.log("Push-Fehler", e.message); }
    }
    fertig.add(a.key);
  }
  const offen = abos.some(a => !fertig.has(a.key) && nachrichtFuer(a, job.ev));
  if (offen) await env.PUSH.put("job", JSON.stringify({ ev: job.ev, fertig: [...fertig] }));
  else await env.PUSH.delete("job");
  return `${job.ev.length} Meldung(en), ${n} verschickt, ${weg} abgemeldet${offen ? ", Rest im nächsten Lauf" : ""}`;
}

// ---------------------------------------------------------------- Schnittstelle für die App
const cors = { "access-control-allow-origin": ORIGIN, "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type", "access-control-max-age": "86400" };
const json = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { ...cors, "content-type": "application/json" } });

async function app(req, env, url) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (!env.PUSH) return json({ fehler: "kein Speicher" }, 503);
  if (url.pathname === "/schluessel") {
    const v = await vapid(env);
    return v ? json({ key: v.pub }) : json({ fehler: "noch kein Schlüssel" }, 503);
  }
  if (req.method !== "POST") return json({ fehler: "?" }, 405);
  let x; try { x = await req.json(); } catch (e) { return json({ fehler: "json" }, 400); }
  const abo = aboPruefen(x);
  if (!abo) return json({ fehler: "ungültig" }, 400);
  const key = await aboKey(abo.e);
  if (url.pathname === "/abmelden" || !abo.t.length) { await env.PUSH.delete(key); return json({ ok: true, teams: [] }); }
  if (url.pathname === "/abo") {
    await env.PUSH.put(key, "1", { metadata: abo });
    return json({ ok: true, teams: abo.t });
  }
  return json({ fehler: "?" }, 404);
}

export default {
  async scheduled(event, env, ctx) {
    if (anstossJetzt(event.scheduledTime)) ctx.waitUntil(anstossen(env));
    if (env.PUSH) ctx.waitUntil(pushTakt(env, event.scheduledTime).then(x => console.log("Push:", x), e => console.log("Push-Fehler:", e.message)));
  },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname !== "/") return app(req, env, url);
    // Statusseite (verrät nichts Geheimes, stößt nichts an).
    const jetzt = new Date();
    let naechster = null;
    for (let t = Math.ceil(jetzt / 9e5) * 9e5, i = 0; i < 4 * 24 * 8; t += 9e5, i++) if (anstossJetzt(t)) { naechster = new Date(t); break; }
    const zeit = d => d.toLocaleString("de-DE", { timeZone: "Europe/Luxembourg", weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" });
    let push = "FEHLT ✗ (Binding PUSH zum KV-Speicher fcjj-push anlegen)";
    if (env.PUSH) {
      const abos = await alleAbos(env), v = await vapid(env);
      push = `verbunden ✓\nSchlüssel: ${v ? "vorhanden ✓" : "wird in der nächsten Minute erzeugt"}\nAnmeldungen: ${abos.length}`;
    }
    return new Response(`FCJJ-App: Abruf-Anstoß und Push\n\nToken: ${env.GITHUB_TOKEN ? "vorhanden ✓" : "FEHLT ✗"}\nPush-Speicher: ${push}\nNächster Anstoß: ${naechster ? zeit(naechster) : "–"}\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } });
  },
};
