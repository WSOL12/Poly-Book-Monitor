import { main } from "./app/monitor.ts";
import { restoreConsole } from "./ui/console.ts";

main().catch((err) => {
  restoreConsole();
  console.error(err);
  process.exit(1);
});
