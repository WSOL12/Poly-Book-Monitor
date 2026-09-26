import { main } from "./app/download.ts";

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
