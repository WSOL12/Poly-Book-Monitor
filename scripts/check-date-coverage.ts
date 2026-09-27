import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve("data");
for (const sport of ["soccer", "football", "mlb", "tennis", "weather"]) {
  const dir = resolve(root, sport);
  if (!existsSync(dir)) {
    console.log(sport, "missing");
    continue;
  }
  for (const f of readdirSync(dir).filter((n) => /^\d{4}-\d{2}/.test(n) && n.endsWith(".db"))) {
    const db = new Database(resolve(dir, f), { readonly: true, fileMustExist: true });
    try {
      const row = db.prepare("SELECT MIN(d) as mn, MAX(d) as mx, COUNT(*) as c FROM ev").get() as {
        mn: string | null;
        mx: string | null;
        c: number;
      };
      const days = db
        .prepare("SELECT d, COUNT(*) c FROM ev GROUP BY d ORDER BY d")
        .all() as Array<{ d: string; c: number }>;
      console.log(
        `${sport}/${f} events=${row.c} date=${row.mn}..${row.mx} distinctDays=${days.length}`,
      );
      console.log("  days:", days.map((x) => `${x.d}(${x.c})`).join(" "));
    } finally {
      db.close();
    }
  }
}
