import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fstatSync } from "node:fs";

const inherited = fstatSync(4);
assert(inherited.isFile());
// A shell/tool grandchild must not retain the supervisor's lifetime lock.
const check = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import { readdirSync, statSync } from 'node:fs';
  const [dev, ino] = process.argv.slice(1).map(Number);
  const leaked = readdirSync('/proc/self/fd').some(fd => {
    try { const s = statSync('/proc/self/fd/' + fd); return s.dev === dev && s.ino === ino; }
    catch { return false; }
  });
  process.exitCode = leaked ? 1 : 0;
`,
    String(inherited.dev),
    String(inherited.ino),
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
assert.equal(check.status, 0, "lifetime lock leaked to a tool grandchild");
process.send?.({ ready: true });
process.once("message", () => process.disconnect());
