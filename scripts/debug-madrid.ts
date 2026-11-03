import { listEvents } from "../web/lib/db.ts";
import { footballCodesMatchTitle, parseFootballSlug } from "../web/lib/footballSlugs.ts";

const soccer = listEvents("soccer").filter((e) => /Madrid/i.test(e.title));
console.log("Madrid poly events", soccer.length);
for (const e of soccer.slice(0, 30)) console.log(e.eventDate, e.title);

const p = parseFootballSlug("pf:lal-mad-rea-2026-09-20")!;
for (const e of soccer) {
  if (footballCodesMatchTitle(p.home, p.away, e.title, p.league)) {
    console.log("HIT", e.eventDate, e.title);
  }
}
