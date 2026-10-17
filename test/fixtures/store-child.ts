// Child process for store tests. Prints one JSON line once it reaches its barrier, then waits to be killed.
import { migrate } from "../../src/storage/migrations.ts";
import { openDatabase } from "../../src/storage/sqlite.ts";
import { openStore } from "../../src/storage/store.ts";

const [mode, target] = process.argv.slice(2);
if (target === undefined) throw new Error("usage: store-child.ts <own|hang-in-migration> <path>");

if (mode === "own") {
  const store = await openStore(target);
  console.log(JSON.stringify({ installationId: store.installationId }));
} else if (mode === "hang-in-migration") {
  const database = await openDatabase(target);
  await migrate(database, [
    { version: 1, name: "first", up: (transaction) => transaction.exec("CREATE TABLE pal_first (x INTEGER) STRICT") },
    {
      version: 2,
      name: "second",
      up: async (transaction) => {
        await transaction.exec("CREATE TABLE pal_second (x INTEGER) STRICT");
        console.log(JSON.stringify({ barrier: "inside second migration" }));
        await new Promise(() => {});
      },
    },
  ]);
} else {
  throw new Error(`unknown mode ${mode}`);
}
setInterval(() => {}, 60_000);
