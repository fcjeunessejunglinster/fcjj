import assert from "node:assert/strict";
import { lesen } from "../tools/news.mjs";
const rss = `<?xml version="1.0"?><rss><channel><title>x</title><item><title><![CDATA[Bayern gewinnt & bleibt oben]]></title><link>https://www.kicker.de/a</link><pubDate>Fri, 13 Nov 2026 18:00:00 GMT</pubDate><description>&lt;p&gt;Text&lt;/p&gt;</description></item>
<item><title>L&#39;OM s&#233;duit</title><link>https://www.lequipe.fr/b</link><pubDate>Fri, 13 Nov 2026 19:30:00 +0100</pubDate></item>
<item><title>ohne Link</title></item></channel></rss>`;
const n = lesen(rss, "kicker");
assert.equal(n.length, 2);
assert.equal(n[0].t, "Bayern gewinnt & bleibt oben");
assert.equal(n[1].t, "L'OM séduit");
assert.equal(n[1].d, "2026-11-13T18:30:00.000Z");
const atom = `<feed><entry><title>Atom-Meldung</title><link rel="alternate" href="https://x.example/c"/><updated>2026-11-13T10:00:00Z</updated></entry></feed>`;
assert.equal(lesen(atom, "q")[0].u, "https://x.example/c");
console.log("News-Test ok");
