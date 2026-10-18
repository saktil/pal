import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { CodemodeNamespace } from "@earendil-works/pi-durable/codemode";
import { Type } from "typebox";
import type { ProjectBrowsers } from "../core/browser.ts";
import { BrowserActionBody } from "../core/browser-page.ts";

export const BROWSER_NAMESPACE: CodemodeNamespace = {
  name: "browser",
  prefix: "browser_",
  description:
    "The project's sandboxed browser, only after the owner explicitly hands it to this chat. Observe text/opaque targets, then request one action. Every mutation needs owner approval, even in Full access. Never enter credentials; ask the owner to use Private login. After any interrupted action inspect before retrying; do not repeat a possibly completed action.",
};

export function browserTools(current: () => ProjectBrowsers | undefined) {
  const requireBrowser = () => {
    const browsers = current();
    if (browsers === undefined) throw new Error("browser runtime is unavailable");
    return browsers;
  };
  return defineExtension({
    name: "pal.browser",
    tools: [
      defineTool({
        name: "browser_observe",
        description:
          "Read bounded visible text and opaque target IDs from the active page. No screenshots, input values, hidden text or private login pages. Observations expire after two minutes and every action; inspect again before a new action.",
        parameters: Type.Object({}, { additionalProperties: false }),
        callers: ["tools"],
        replay: "unsafe",
        structuredOutputSchema: Type.Object({}, { additionalProperties: true }),
        outputLimits: { maxBytes: 32 * 1024, maxLines: 1000 },
        execute: async (_args, api, context) => {
          const browser = requireBrowser();
          const result = await browser.observe(api.conversationId, context.abortSignal);
          browser.assertEpoch(api.conversationId, result.session, result.epoch);
          await api.commit(
            (tx) =>
              tx.appendEntry(api.conversationId, {
                kind: "pal.browser",
                data: { action: "observe", session: result.session, epoch: result.epoch },
              }),
            context,
          );
          browser.assertEpoch(api.conversationId, result.session, result.epoch);
          return { structuredOutput: result };
        },
      }),
      defineTool({
        name: "browser_act",
        description:
          "Request one exact action against the observed session/epoch/page. Click/type use only opaque target IDs, never selectors or JavaScript. Owner approval precedes intent; an interrupted dispatch is never replayed. Reinspect afterwards. Login/password/OTP pages require the owner.",
        parameters: BrowserActionBody,
        callers: ["tools"],
        replay: "unsafe",
        structuredOutputSchema: Type.Object({}, { additionalProperties: true }),
        outputLimits: { maxBytes: 4096, maxLines: 100 },
        execute: async (args, api, context) => {
          const browser = requireBrowser();
          const result = await browser.act(api.conversationId, args, context.abortSignal);
          browser.assertEpoch(api.conversationId, result.session, result.epoch);
          await api.commit(
            (tx) =>
              tx.appendEntry(api.conversationId, {
                kind: "pal.browser",
                data: { action: result.action, session: result.session, epoch: result.epoch },
              }),
            context,
          );
          browser.assertEpoch(api.conversationId, result.session, result.epoch);
          return { structuredOutput: result };
        },
      }),
    ],
  });
}
