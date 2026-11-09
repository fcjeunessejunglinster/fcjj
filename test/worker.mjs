// Prüft, wann der Cloudflare-Worker den Abruf anstößt (eine Woche im Viertelstundentakt).
import assert from "node:assert/strict";
import { abrufFaellig } from "../tools/cloudflare-worker.js";
const lux = s => new Date(s);
// Winterzeit (UTC+1)
assert.equal(abrufFaellig(lux("2026-11-14T08:00:00+01:00")), true);   // Sa 8:00
assert.equal(abrufFaellig(lux("2026-11-14T14:45:00+01:00")), true);   // Sa 14:45
assert.equal(abrufFaellig(lux("2026-11-14T22:00:00+01:00")), true);   // Sa 22:00
assert.equal(abrufFaellig(lux("2026-11-14T22:15:00+01:00")), false);  // Sa 22:15
assert.equal(abrufFaellig(lux("2026-11-14T23:30:00+01:00")), true);   // Sa 23:30
assert.equal(abrufFaellig(lux("2026-11-15T03:00:00+01:00")), false);  // So nachts
assert.equal(abrufFaellig(lux("2026-11-16T07:00:00+01:00")), true);   // Mo 7:00
assert.equal(abrufFaellig(lux("2026-11-16T10:15:00+01:00")), false);  // Mo 10:15
assert.equal(abrufFaellig(lux("2026-11-16T12:15:00+01:00")), true);   // Mo 12:15
assert.equal(abrufFaellig(lux("2026-11-16T21:15:00+01:00")), true);   // Mo 21:15
assert.equal(abrufFaellig(lux("2026-11-16T21:30:00+01:00")), false);  // Mo 21:30
// Sommerzeit (UTC+2)
assert.equal(abrufFaellig(lux("2027-04-10T08:00:00+02:00")), true);
assert.equal(abrufFaellig(lux("2027-04-10T07:45:00+02:00")), false);
// Anzahl je Woche
let n = 0;
for (let t = Date.parse("2026-11-16T00:00:00+01:00"); t < Date.parse("2026-11-23T00:00:00+01:00"); t += 9e5) if (abrufFaellig(new Date(t))) n++;
console.log("Anstöße pro Woche:", n);
assert.ok(n > 100 && n < 200);
console.log("Worker-Test ok");

// ---- Cron jede Minute: nur einmal je Viertelstunde anstoßen
import W, { anstossJetzt, verschluesseln, unb64u, b64u, aboPruefen, nachrichtFuer, pushTakt } from "../tools/cloudflare-worker.js";
import nc from "node:crypto";
n = 0;
for (let t = Date.parse("2026-11-16T00:00:00+01:00"); t < Date.parse("2026-11-23T00:00:00+01:00"); t += 6e4) if (anstossJetzt(t)) n++;
console.log("Anstöße pro Woche bei Cron jede Minute:", n);
assert.ok(n > 100 && n < 200);

// ---- Verschlüsselung (RFC 8291) mit Node-crypto unabhängig entschlüsseln, wie es der Browser tut
const ua = nc.createECDH("prime256v1"); ua.generateKeys();
const auth = nc.randomBytes(16);
const sub = { endpoint: "https://fcm.googleapis.com/fcm/send/abc", keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } };
const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
const text = JSON.stringify({ t: "FCJJ MIN 1", b: "Jeunesse Junglinster – Mamer 5:2 #YOUth ROCKs! 🤘" });
const body = Buffer.from(await verschluesseln(sub, text, eph));
const salt = body.subarray(0, 16), rs = body.readUInt32BE(16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
assert.equal(rs, 4096); assert.equal(idlen, 65);
const geteilt = ua.computeSecret(asPub);
const ikm = Buffer.from(nc.hkdfSync("sha256", geteilt, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPub]), 32));
const cek = Buffer.from(nc.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
const nonce = Buffer.from(nc.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
const dec = nc.createDecipheriv("aes-128-gcm", cek, nonce); dec.setAuthTag(ct.subarray(-16));
const klar = Buffer.concat([dec.update(ct.subarray(0, -16)), dec.final()]);
assert.equal(klar[klar.length - 1], 2);
assert.equal(klar.subarray(0, -1).toString(), text);
console.log("Verschlüsselung ok");

// ---- Anmeldung prüfen
assert.ok(aboPruefen({ sub, teams: [9000701], lang: "fr" }));
assert.equal(aboPruefen({ sub: { ...sub, endpoint: "https://boese.example/x" }, teams: [1] }), null);
assert.equal(aboPruefen({ sub, teams: ["<script>"] }), null);

// ---- Ganzer Ablauf mit nachgebautem KV und fetch
const kv = new Map();
const env = { PUSH: {
  async get(k, typ) { const v = kv.get(k)?.v; return v == null ? null : typ === "json" ? JSON.parse(v) : v; },
  async put(k, v, o) { kv.set(k, { v, m: o?.metadata }); },
  async delete(k) { kv.delete(k); },
  async list({ prefix }) { return { keys: [...kv].filter(([k]) => k.startsWith(prefix)).map(([name, x]) => ({ name, metadata: x.m })), list_complete: true }; },
} };
const jetzt = Date.parse("2026-11-14T17:00:00+01:00");
const ev = [
  { id: "erg:1:9000703", team: 9000703, ab: "2026-11-14T16:50:00+01:00", bis: "2026-11-15T04:50:00+01:00", t: { de: "FCJJ MIN 1", en: "FCJJ MIN 1", fr: "FCJJ MIN 1" }, b: { de: "A – B 5:2", en: "A – B 5:2", fr: "A – B 5:2" } },
  { id: "erin:2", team: 9000704, ab: "2026-11-14T18:00:00+01:00", bis: "2026-11-15T10:00:00+01:00", t: { de: "x" }, b: { de: "y" } },
];
const gesendet = [];
globalThis.fetch = async (url, o) => {
  url = String(url);
  if (url.includes("meldungen.json")) return new Response(JSON.stringify({ ev }), { status: 200 });
  gesendet.push({ url, o });
  return new Response("", { status: url.includes("weg") ? 410 : 201 });
};
const req = (pfad, x) => W.fetch(new Request("https://fcjj.x.workers.dev" + pfad, { method: "POST", body: JSON.stringify(x) }), env);
// vor dem ersten Cron-Lauf gibt es noch keinen Schlüssel
assert.equal((await W.fetch(new Request("https://fcjj.x.workers.dev/schluessel"), env)).status, 503);
console.log(await pushTakt(env, jetzt));
const sk = await (await W.fetch(new Request("https://fcjj.x.workers.dev/schluessel"), env)).json();
assert.equal(unb64u(sk.key).length, 65);
assert.equal((await req("/abo", { sub, teams: ["9000703"], lang: "de" })).status, 200);
const ua2 = nc.createECDH("prime256v1"); ua2.generateKeys();
const sub2 = { endpoint: "https://web.push.apple.com/weg", keys: { p256dh: b64u(ua2.getPublicKey()), auth: b64u(nc.randomBytes(16)) } };
assert.equal((await req("/abo", { sub: sub2, teams: ["9000703", "9000704"] })).status, 200);
const sub3 = { endpoint: "https://fcm.googleapis.com/fcm/send/andere", keys: sub.keys };
assert.equal((await req("/abo", { sub: sub3, teams: ["9000799"] })).status, 200);
kv.delete("gesendet");
console.log(await pushTakt(env, jetzt));
assert.equal(gesendet.length, 2);   // nur MIN-1-Abos; „erin“ ist noch nicht fällig
assert.equal(gesendet[0].o.headers["content-encoding"], "aes128gcm");
assert.match(gesendet[0].o.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
// JWT-Signatur mit dem öffentlichen Schlüssel prüfen
const [, jwt, k] = gesendet[0].o.headers.authorization.match(/t=(\S+), k=(\S+)/);
const [h, p, s] = jwt.split(".");
const pub = nc.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(unb64u(k).slice(1, 33)), y: b64u(unb64u(k).slice(33)) }, format: "jwk" });
assert.ok(nc.verify("sha256", Buffer.from(h + "." + p), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(unb64u(s))));
assert.equal(JSON.parse(Buffer.from(unb64u(p))).aud, "https://fcm.googleapis.com");
// Apple meldete 410 → Anmeldung gelöscht
assert.equal([...kv.keys()].filter(k => k.startsWith("abo:")).length, 2);
// zweiter Lauf: nichts doppelt
gesendet.length = 0;
console.log(await pushTakt(env, jetzt + 6e4));
assert.equal(gesendet.length, 0);
// 18:00: Erinnerung für MIN 2 – niemand hat MIN 2 abonniert ausser dem gelöschten Apple-Handy
console.log(await pushTakt(env, Date.parse("2026-11-14T18:00:00+01:00")));
assert.equal(gesendet.length, 0);
// abmelden
assert.equal((await req("/abmelden", { sub, teams: [] })).status, 200);
assert.equal([...kv.keys()].filter(k => k.startsWith("abo:")).length, 1);
// mehrere Meldungen für ein Handy → eine Mitteilung
const m = nachrichtFuer({ t: ["1", "2"], l: "fr" }, [{ id: "a", team: 1, t: { fr: "FCJJ MIN 1" }, b: { fr: "x" } }, { id: "b", team: 2, t: { fr: "FCJJ MIN 2" }, b: { fr: "y" } }]);
assert.equal(m.b, "MIN 1: x\nMIN 2: y");
console.log("Push-Test ok");
