import { HttpError } from "../../src/core/http.ts";
import type { ReleaseRpc, ReleaseOperation } from "../../src/core/release-rpc.ts";
import type { ReleaseView, ReleaseReview } from "../../src/core/supervise.ts";

/** UI/route fixture only. Actual Nix gates, process recovery and selection have separate host fixtures. */
export function fakeReleaseControl() {
  const digest = "e".repeat(64),
    previous = "a".repeat(64);
  let enabled = false,
    approved = false,
    rejectActivation = false;
  const calls: { op: ReleaseOperation; args: unknown }[] = [];
  const view = (): ReleaseView =>
    enabled
      ? {
          available: true,
          evaluator: `/nix/store/${"0".repeat(32)}-pal`,
          dataRoot: "/data/pal",
          current: { digest: "b".repeat(64), package: `/nix/store/${"0".repeat(32)}-pal` },
          previous: { digest: previous, package: `/nix/store/${"1".repeat(32)}-pal` },
          busy: false,
          lastError: null,
          retained: 2,
          candidates: [
            {
              digest,
              package: `/nix/store/${"2".repeat(32)}-pal`,
              candidate: "/worktrees/release-fixture",
              source: "f".repeat(64),
              checkedAt: 1_800_000_000_000,
              changes: ["web/src/app.css"],
              approved,
            },
          ],
        }
      : { available: false };
  const access: Pick<ReleaseRpc, "call"> = {
    call: async (op, args = {}) => {
      calls.push({ op, args });
      if (op === "view") return view();
      if (!enabled) throw new HttpError(409, "release_unavailable", "Fixture release control is off.");
      if (op === "review")
        return {
          path: "web/src/app.css",
          before: { text: "body { color: white; }", truncated: false },
          after: {
            text: '<img src=x onerror="window.releaseInjected=true">\nbody { color: silver; }',
            truncated: false,
          },
        } satisfies ReleaseReview;
      if (op === "approve") {
        approved = true;
        return { approved: digest };
      }
      if (op === "activate" && rejectActivation) {
        approved = false;
        throw new HttpError(409, "release_changed", "Candidate changed; its approval is invalid.");
      }
      if (op === "activate" || op === "rollback") return { restarting: true };
      throw new HttpError(400, "release_operation", "Unexpected fixture operation.");
    },
  };
  return {
    digest,
    previous,
    calls,
    access,
    view,
    enable: () => {
      enabled = true;
      approved = false;
      rejectActivation = false;
      calls.length = 0;
    },
    disable: () => {
      enabled = false;
    },
    rejectActivation: () => {
      rejectActivation = true;
    },
  };
}
