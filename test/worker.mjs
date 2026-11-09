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
