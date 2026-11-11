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

// ---- Chat „Frag die App“
import { chat } from "../tools/cloudflare-worker.js";
{
  const kv = new Map();
  const env = { ANTHROPIC_API_KEY: "sk-test", PUSH: { get: async k => kv.get(k) ?? null, put: async (k, v) => { kv.set(k, v); } } };
  let gesendet = null;
  globalThis.fetch = async (u, o) => { gesendet = { u, body: JSON.parse(o.body), h: o.headers };
    return new Response(JSON.stringify({ content: [{ type: "text", text: "MIN 1 spielt am Samstag um 10:00." }] }), { status: 200 }); };
  const frag = (x, origin = "https://fcjeunessejunglinster.github.io", ip = "1.2.3.4") => chat(new Request("https://fcjj.x.workers.dev/frage",
    { method: "POST", headers: { origin, "cf-connecting-ip": ip, "content-type": "application/json" }, body: JSON.stringify(x) }), env);
  let r = await frag({ frage: "Wann spielt MIN 1?", kontext: "## MIN 1 …", verlauf: [{ rolle: "assistant", text: "Hallo" }, { rolle: "user", text: "Hi" }, { rolle: "assistant", text: "Hallo!" }] });
  const j = await r.json();
  assert.equal(r.status, 200); assert.equal(j.antwort, "MIN 1 spielt am Samstag um 10:00."); assert.equal(j.rest, 19);
  assert.equal(gesendet.u, "https://api.anthropic.com/v1/messages");
  assert.equal(gesendet.h["x-api-key"], "sk-test");
  assert.match(gesendet.body.system, /<vereinsdaten>\n## MIN 1/);
  assert.deepEqual(gesendet.body.messages.map(m => m.role), ["user", "assistant", "user"]);   // Verlauf beginnt mit user
  assert.equal((await frag({ frage: "x" }, "https://boese.example")).status, 403);
  assert.equal((await frag({ frage: "" })).status, 400);
  for (let i = 0; i < 19; i++) await frag({ frage: "x" });
  assert.equal((await frag({ frage: "x" })).status, 429);                // 21. Frage vom selben Anschluss
  assert.equal((await frag({ frage: "x" }, undefined, "5.6.7.8")).status, 200);   // anderes Handy geht noch
  assert.equal((await chat(new Request("https://x/frage", { method: "OPTIONS" }), env)).status, 204);
  assert.equal((await frag({ frage: "x" }).then(() => chat(new Request("https://x/frage", { method: "POST", headers: { origin: "https://fcjeunessejunglinster.github.io" }, body: "{}" }), { }))).status, 503);
  console.log("Chat-Test ok");
}
