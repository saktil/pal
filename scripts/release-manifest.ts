import { writeFile } from "node:fs/promises";
import { manifest, readSource, sourcePaths } from "../src/core/release-policy.ts";

const [root, packagePath, nixpkgs, output] = process.argv.slice(2);
if (!root || !packagePath || !nixpkgs || !output) throw new Error("missing release manifest build arguments");
const snapshot = await readSource(root, await sourcePaths(root), false);
await writeFile(output, `${JSON.stringify(manifest(snapshot, packagePath, nixpkgs), null, 2)}\n`);
