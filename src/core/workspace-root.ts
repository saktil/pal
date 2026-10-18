import { lstat, realpath } from "node:fs/promises";
import { FileAccessError } from "./files.ts";

/** Directory identity excludes mutable timestamps, but detects replacement and link-root changes. */
export async function directoryIdentity(root: string): Promise<string> {
  const info = await lstat(root, { bigint: true });
  if (!info.isDirectory() || (await realpath(root)) !== root)
    throw new FileAccessError("the granted folder is no longer a canonical directory");
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`;
}
