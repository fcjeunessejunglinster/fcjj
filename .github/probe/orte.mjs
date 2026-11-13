// Vorübergehend: für jeden Spielort Fußballplätze aus OpenStreetMap (Overpass) und eine Nominatim-Suche holen.
import { readFileSync, writeFileSync } from "node:fs";
const orte = JSON.parse(readFileSync(".github/probe/orte.json", "utf8"));
const pause = ms => new Promise(r => setTimeout(r, ms));
const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
async function overpass(q) {
  for (let v = 0; v < 4; v++) {
    try { const r = await fetch(OVERPASS[v % 3], { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "user-agent": "fcjj-app-probe" }, signal: AbortSignal.timeout(90000) });
      if (r.ok) return (await r.json()).elements; } catch (e) {}
    await pause(3000);
  }
  return null;
}
const aus = [];
for (const o of orte) {
  const e = { ...o, osm: null, nom: [] };
  if (o.k) {
    const els = await overpass(`[out:json][timeout:60];nwr(around:3000,${o.k[0]},${o.k[1]})[leisure~"^(pitch|stadium|sports_centre)$"][sport~"soccer|multi"];out center tags;`);
    e.osm = els && els.map(x => ({ id: x.type[0] + x.id, lat: x.lat ?? x.center?.lat, lon: x.lon ?? x.center?.lon, t: x.tags }));
  }
  for (const q of [`${o.name} ${o.stadt || ""}`.trim(), `stade ${o.stadt || ""}`.trim()]) {
    try { const r = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=lu&limit=5&q=${encodeURIComponent(q)}`, { headers: { "user-agent": "fcjj-app-probe/1.0 (github.com/fcjeunessejunglinster/fcjj)" }, signal: AbortSignal.timeout(30000) });
      if (r.ok) e.nom.push({ q, r: (await r.json()).map(x => ({ n: x.display_name, lat: +x.lat, lon: +x.lon, typ: x.type })) }); } catch (x) {}
    await pause(1200);
  }
  aus.push(e); writeFileSync("out/orte.json", JSON.stringify(aus, null, 1)); console.log(o.ort, e.osm?.length, e.nom.map(n => n.r.length));
}
writeFileSync("out/orte.json", JSON.stringify(aus, null, 1));
