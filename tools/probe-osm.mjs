// Einmalig: alle Fußballplätze/Stadien in Luxemburg (+ Grenzstreifen) aus OpenStreetMap (Overpass).
import { writeFileSync } from "node:fs";
const q = `[out:json][timeout:120];
(
  nwr["leisure"="pitch"]["sport"~"soccer"](49.40,5.70,50.20,6.56);
  nwr["leisure"="stadium"](49.40,5.70,50.20,6.56);
  nwr["leisure"="sports_centre"]["sport"~"soccer"](49.40,5.70,50.20,6.56);
);
out center tags;`;
for (const url of ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter", "https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass-api.de/api/interpreter"]) {
  await new Promise(r => setTimeout(r, 5000));
  try {
    const r = await fetch(url, { method: "POST", body: "data=" + encodeURIComponent(q), headers: { "user-agent": "fcjj-app (club fixtures app)" } });
    const j = await r.json();
    const out = j.elements.map(e => ({ id: e.type[0] + e.id, lat: e.lat ?? e.center?.lat, lon: e.lon ?? e.center?.lon,
      name: e.tags.name || "", leisure: e.tags.leisure, surface: e.tags.surface || "", street: e.tags["addr:street"] || "", nr: e.tags["addr:housenumber"] || "", city: e.tags["addr:city"] || "" }));
    writeFileSync("osm-plaetze.json", JSON.stringify(out));
    console.log("OSM", out.length, "Plätze");
    break;
  } catch (e) { console.log("Fehler", url, e.message); }
}
