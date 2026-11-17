// Prüft den Live-Stand von SportEasy im Worker mit nachgebauten SportEasy-Antworten (kein Netz).
import assert from "node:assert/strict";
import { live } from "../tools/cloudflare-worker.js";

const heute = new Date().toISOString().slice(0, 10);
const aufrufe = [];
let angemeldet = false;
globalThis.caches = { default: { match: async () => null, put: async () => {} } };
globalThis.fetch = async (url, opt = {}) => {
  const u = String(url), h = opt.headers || {};
  aufrufe.push(u);
  const json = (x, status = 200, kopf = {}) => new Response(JSON.stringify(x), { status, headers: { "content-type": "application/json", ...kopf } });
  if (u.endsWith("/account/csrf/")) return json({}, 200, { "set-cookie": "csrftoken=abc; Path=/" });
  if (u.endsWith("/account/authenticate/")) {
    const b = JSON.parse(opt.body);
    assert.equal(h["x-csrftoken"], "abc");
    if (b.username !== "app@fcjj.lu" || b.password !== "geheim") return json({}, 400);
    angemeldet = true;
    return json({ ok: true }, 200, { "set-cookie": "sessionid=s1; Path=/; HttpOnly" });
  }
  if (!angemeldet || !String(h.cookie).includes("sessionid=s1")) return json({}, 401);
  if (u.endsWith("/teams/3783759/events/")) return json({ results: [
    { id: 1, start_at: `${heute}T11:00:00+01:00`, is_cancelled: false,
      opponent_left: { full_name: "FC Jeunesse Junglinster - Jeunes Filles WU13 26-27", score: "2", is_current_team: true, is_home: true },
      opponent_right: { full_name: "ENT Wormeldange", score: "1", is_current_team: false } },
    { id: 2, start_at: "2026-01-01T11:00:00+01:00", opponent_left: { full_name: "x" }, opponent_right: { full_name: "y" } },
    { id: 3, start_at: `${heute}T18:00:00+01:00`, name: "Training" } ] });
  if (u.endsWith("/events/last-next/")) return json({ last_event: null, next_event: null });
  if (u.endsWith("/events/1/live-stats/events/")) return json({ results: [
    { action_slug_name: "football_goal", time: 30, period: 1, opponent: "opponent_right", is_missed: false, profile: { first_name: "Kind", last_name: "Geheim" } },
    { action_slug_name: "football_goal", time: 12, period: 1, opponent: "opponent_left", is_missed: false, profile: { first_name: "Kind", last_name: "Geheim" } },
    { action_slug_name: "football_goal", time: 40, period: 2, opponent: "opponent_left", is_missed: true },
    { action_slug_name: "football_yellow_card", time: 5, period: 2, opponent: "opponent_left" },
    { action_slug_name: "football_goal", time: 3, period: 2, opponent: "opponent_left", is_missed: false } ] });
  return json({}, 404);
};
const env = { SE_USER: "app@fcjj.lu", SE_PASSWORD: "geheim" };
const holen = async (kat, e = env) => { const r = await live(new Request("https://w/live?kat=" + kat), e); return { s: r.status, j: await r.json(), r }; };

// ohne Secrets: aus
assert.equal((await holen("WU13", {})).s, 503);
// falsche Kategorie
assert.equal((await holen("SEN")).s, 400);
// richtiger Ablauf
const a = await holen("WU13");
assert.equal(a.s, 200);
assert.equal(a.r.headers.get("access-control-allow-origin"), "https://fcjeunessejunglinster.github.io");
assert.equal(a.j.spiele.length, 1);
const sp = a.j.spiele[0];
assert.deepEqual([sp.links.tore, sp.rechts.tore, sp.links.wir], [2, 1, true]);
assert.deepEqual(sp.tore.map(t => [t.halb, t.min, t.seite]), [[1, 12, "links"], [1, 30, "rechts"], [2, 3, "links"]]);
assert.ok(!JSON.stringify(a.j).includes("Geheim"), "keine Spielernamen");
// falsches Passwort → Fehler, kein Absturz
angemeldet = false;
assert.equal((await holen("WU13", { SE_USER: "app@fcjj.lu", SE_PASSWORD: "falsch" })).s, 502);
console.log("SportEasy-Live im Worker: ok");
