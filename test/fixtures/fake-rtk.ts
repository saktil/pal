import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A stand-in `rtk` first on PATH, following the real one's rewrite exit codes: `report …` has an equivalent (3),
 * `allowed …` one covered by allow rules (0), `denied …` a pipeline denial (2), anything else none (1). The
 * equivalent `rtk report <word> <code>` prints `compact:<word>` and exits with <code>. Every call is logged with the
 * HOME it saw. Returns the log reader and a cleanup that restores PATH.
 */
export async function fakeRtk() {
  const bin = await realpath(await mkdtemp(join(tmpdir(), "pal-fake-rtk-")));
  const log = join(bin, "calls");
  await writeFile(
    join(bin, "rtk"),
    `#!/bin/sh
printf '%s|%s\\n' "$HOME" "$*" >> '${log}'
if [ "$1" = rewrite ]; then
  case "$2" in
    "report "*) printf 'rtk %s\\n' "$2"; exit 3 ;;
    "allowed "*) printf 'rtk report %s\\n' "\${2#allowed }"; exit 0 ;;
    "denied "*) printf 'blocked by a pipeline rule\\n'; exit 2 ;;
    *) exit 1 ;;
  esac
fi
if [ "$1" = report ]; then printf 'compact:%s\\n' "$2"; exit "$3"; fi
exit 99
`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  return {
    calls: async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
          const [home = "", args = ""] = line.split("|");
          return { home, args };
        }),
    cleanup: async () => {
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
      await rm(bin, { recursive: true, force: true });
    },
  };
}
