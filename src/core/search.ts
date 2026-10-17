import { realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { FileFinder } from "@ff-labs/fff-node";
import { isProtected } from "./files.ts";

const MAX_FINDERS = 3;
const IDLE_MS = 5 * 60_000;
const SCAN_WAIT_MS = 10_000;
const WATCH_WAIT_MS = 1_000;
const WATCH_NOT_READY = "Failed to subscribe: File system watcher is not ready";
const PAGE = 50;
const LINE_CHARS = 300;

export type SearchMode = "files" | "text" | "regex";
export type SearchHit = {
  /** Relative to the project folder. */
  readonly path: string;
  readonly line?: number;
  readonly text?: string;
  /** Character ranges of the match within `text`. */
  readonly ranges?: readonly (readonly [number, number])[];
};
export type SearchResults = {
  readonly mode: SearchMode;
  readonly hits: readonly SearchHit[];
  /** More matches exist, or the time budget ran out, than are shown. */
  readonly truncated: boolean;
  /** A scan or watcher-gap recovery has not finished, so results may be incomplete. */
  readonly indexing: boolean;
};

/** A folder Pal will not index, or a query it will not run; reported, never replaced by another search. */
export class SearchError extends Error {}

type Index = {
  finder: FileFinder;
  used: number;
  scanned: boolean;
  rescan: boolean;
  unwatch?: () => void;
  pending: Promise<void> | undefined;
};

/**
 * Shared, lazy fff indexes for project folders: created on first search, at most a few alive, destroyed after idling
 * and when their project goes. A folder containing Pal's own data is never indexed, so its files cannot be read into
 * an index before results are filtered.
 */
export class ProjectSearch {
  readonly #deny: readonly string[];
  readonly #indexes = new Map<string, Index>();
  readonly #sweep: NodeJS.Timeout;

  constructor(deny: readonly string[]) {
    this.#deny = deny;
    this.#sweep = setInterval(() => this.reclaim(Date.now() - IDLE_MS), 60_000).unref();
  }

  async search(configured: string, query: string, mode: SearchMode): Promise<SearchResults> {
    if (query.trim() === "") throw new SearchError("type something to search for");
    const root = await realpath(configured);
    const index = await this.#index(root);
    const keep = (path: string) => {
      const target = join(root, path);
      const between = relative(root, target);
      return !between.startsWith("..") && !isAbsolute(between) && !isProtected(this.#deny, root, target);
    };
    if (mode === "files") {
      const found = index.finder.fileSearch(query, { pageSize: PAGE });
      if (!found.ok) throw new SearchError(found.error);
      const hits = found.value.items.flatMap((item) => (keep(item.relativePath) ? [{ path: item.relativePath }] : []));
      return { mode, hits, truncated: found.value.totalMatched > hits.length, indexing: !index.scanned };
    }
    const found = index.finder.grep(query, {
      mode: mode === "regex" ? "regex" : "plain",
      pageSize: PAGE,
      maxMatchesPerFile: 20,
      timeBudgetMs: 2_000,
      enforceTimeBudget: true,
    });
    if (!found.ok) throw new SearchError(found.error);
    // fff falls back to literal matching on a bad pattern; Pal reports the error instead.
    if (found.value.regexFallbackError !== undefined)
      throw new SearchError(`invalid regex: ${found.value.regexFallbackError}`);
    const hits = found.value.items.flatMap((item) => {
      // fff's per-match `isBinary` mislabels some text files (it can follow file-type tables where `.ts` is video);
      // grep already skips binary content, so only a stray NUL byte disqualifies a matched line.
      if (item.lineContent.includes("\u0000") || !keep(item.relativePath)) return [];
      const text = item.lineContent.slice(0, LINE_CHARS);
      // fff reports byte ranges; convert to character offsets for the UTF-16 line text.
      const toChars = (bytes: number) =>
        Buffer.from(item.lineContent, "utf8").subarray(0, bytes).toString("utf8").length;
      return [
        {
          path: item.relativePath,
          line: item.lineNumber,
          text,
          ranges: item.matchRanges
            .map(([start, end]) => [toChars(start), toChars(end)] as const)
            .filter(([start]) => start < text.length),
        },
      ];
    });
    return { mode, hits, truncated: found.value.nextCursor !== null, indexing: !index.scanned };
  }

  /** Release a folder's index at once, as when its project is removed. */
  async forget(configured: string): Promise<void> {
    this.#drop(await realpath(configured).catch(() => configured));
  }

  close(): void {
    clearInterval(this.#sweep);
    for (const root of [...this.#indexes.keys()]) this.#drop(root);
  }

  /** How many indexes are alive, for tests of reclamation. */
  get size(): number {
    return this.#indexes.size;
  }

  /** Destroy indexes last used before `before`; the sweep passes now minus the idle limit. */
  reclaim(before: number): void {
    for (const [root, index] of this.#indexes) if (index.used < before) this.#drop(root);
  }

  async #index(root: string): Promise<Index> {
    const existing = this.#indexes.get(root);
    if (existing !== undefined && !existing.finder.isDestroyed) {
      existing.used = Date.now();
      await this.#scan(root, existing);
      return existing;
    }
    if (existing !== undefined) this.#drop(root);
    if (this.#deny.some((denied) => isAncestorOf(root, denied) && !isAncestorOf(denied, root))) {
      throw new SearchError(
        "this folder contains Pal's own data, so Pal does not index it; search a project inside it",
      );
    }
    // No background content index or mmap cache: searches read files directly, so an idle index holds little
    // memory and results never depend on how far background indexing has got.
    const created = FileFinder.create({
      basePath: root,
      aiMode: true,
      disableMmapCache: true,
      disableContentIndexing: true,
    });
    if (!created.ok) throw new SearchError(`search is unavailable for this folder: ${created.error}`);
    while (this.#indexes.size >= MAX_FINDERS) {
      const oldest = [...this.#indexes.entries()].sort((a, b) => a[1].used - b[1].used)[0];
      if (oldest === undefined) break;
      this.#drop(oldest[0]);
    }
    const index: Index = { finder: created.value, used: Date.now(), scanned: false, rescan: false, pending: undefined };
    this.#indexes.set(root, index);
    await this.#scan(root, index);
    return index;
  }

  async #scan(root: string, index: Index): Promise<void> {
    const pending = (index.pending ??= this.#ready(root, index));
    try {
      await pending;
    } finally {
      if (index.pending === pending) index.pending = undefined;
    }
  }

  async #ready(root: string, index: Index): Promise<void> {
    if (index.rescan) {
      const started = index.finder.scanFiles();
      if (!started.ok) throw new SearchError(`search recovery failed: ${started.error}`);
      index.rescan = false;
    }
    if (!index.scanned) {
      const scan = await index.finder.waitForScan(SCAN_WAIT_MS);
      if (!scan.ok) throw new SearchError(`search scan failed: ${scan.error}`);
      if (index.finder.isDestroyed) throw new SearchError("search index was released; try again");
      // A second gap during the wait still needs a scan; never label that snapshot complete.
      index.scanned = scan.value === true && !index.rescan;
    }
    if (index.scanned && index.unwatch === undefined) {
      const deadline = Date.now() + WATCH_WAIT_MS;
      let retried = false;
      // In fff 0.11, scan completion can precede native watcher startup.
      for (;;) {
        if (this.#indexes.get(root) !== index || index.finder.isDestroyed)
          throw new SearchError("search index was released; try again");
        const watching = index.finder.watch((events) => {
          if (this.#indexes.get(root) !== index || !events.some((event) => event.kind === "rescan")) return;
          index.scanned = false;
          index.rescan = true;
        });
        if (watching.ok) {
          index.unwatch = watching.value;
          break;
        }
        if (watching.error !== WATCH_NOT_READY || Date.now() >= deadline) {
          this.#drop(root);
          throw new SearchError(`search watcher is unavailable: ${watching.error}`);
        }
        retried = true;
        await sleep(50);
      }
      if (retried) {
        index.scanned = false;
        index.rescan = true;
        await this.#ready(root, index);
      }
    }
  }

  #drop(root: string): void {
    const index = this.#indexes.get(root);
    this.#indexes.delete(root);
    index?.unwatch?.();
    if (index !== undefined && !index.finder.isDestroyed) index.finder.destroy();
  }
}

function isAncestorOf(ancestor: string, path: string): boolean {
  const between = relative(ancestor, path);
  return between === "" || (!between.startsWith("..") && !isAbsolute(between));
}
