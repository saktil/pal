import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

let found: string | undefined;

/**
 * GNU timeout, which gives host commands a deadline that holds even if Pal dies. The Nix package pins it in
 * PAL_TIMEOUT; elsewhere it is `timeout` on PATH, or `gtimeout` where Homebrew's coreutils installs it (macOS).
 * Without either, the plain name is returned and the spawn fails, so no command runs without its deadline.
 */
export function gnuTimeout(): string {
  if (process.env.PAL_TIMEOUT !== undefined) return process.env.PAL_TIMEOUT;
  found ??= ["timeout", "gtimeout"]
    .flatMap((name) =>
      (process.env.PATH ?? "").split(delimiter).flatMap((dir) => (isAbsolute(dir) ? [join(dir, name)] : [])),
    )
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  return found ?? "timeout";
}
