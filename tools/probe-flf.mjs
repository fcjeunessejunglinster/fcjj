// Einmalig: Führt die FLF inzwischen Bambini-Spiele (Altersklasse 12 „U7 Bambinis“)?
const API = "https://extranet.flf.lu/api/graphql";
const Q = `query($c: MatchCriteria){ matches(criteria:$c){ match{ id matchDate isPlayed gameday } division{ id name } matchType{ id }
  homeTeam{ id name } awayTeam{ id name } sportField{ name } } }`;
const gq = async c => { const r = await fetch(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: Q, variables: { c } }) }); return r.json(); };
const zeit = { seasonId: "20262027", startDate: "2026-07-01", endDate: "2027-06-30", matchTypeId: "ALL" };
for (const [n, c] of [["FCJJ U7", { ...zeit, clubId: 500062, ageCategoryId: 12 }], ["alle Vereine U7", { ...zeit, ageCategoryId: 12 }], ["FCJJ U7 2025-26", { seasonId: "20252026", startDate: "2025-07-01", endDate: "2026-06-30", matchTypeId: "ALL", clubId: 500062, ageCategoryId: 12 }]]) {
  const j = await gq(c);
  if (j.errors) { console.log("BAM", n, "Fehler", JSON.stringify(j.errors).slice(0, 300)); continue; }
  const m = j.data.matches || [];
  console.log("BAM", n, "→", m.length, "Spiele", [...new Set(m.map(x => x.division.name))].slice(0, 6).join(" | "));
  for (const x of m.slice(0, 5)) console.log("BAM   ", x.match.matchDate, x.homeTeam.name, "–", x.awayTeam.name, "|", x.sportField?.name, "|", x.division.name);
  await new Promise(r => setTimeout(r, 1000));
}
