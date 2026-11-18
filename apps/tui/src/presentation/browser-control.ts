import {
  createPreviewStreamClient,
  previewStreamHostSetupMessage,
  type PreviewStreamClient,
  type PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type { DeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class BrowserActionError extends Schema.TaggedError<BrowserActionError>()("TuiBrowserActionError", {
  message: Schema.String,
}) {}
const isBrowserActionError = Schema.is(BrowserActionError);

export async function controlBrowser(
  access: DeviceHubAccess,
  threadId: string,
  tabId: string,
  input: PreviewStreamInput,
  check: () => void,
) {
  check();
  let client: PreviewStreamClient | undefined;
  let takingControl = false;
  let sentAction = false;
  let completed = false;
  try {
    await Effect.runPromise(
      Effect.tryPromise({
        try: () =>
          new Promise<void>((resolve, reject) => {
            client = createPreviewStreamClient(
              { access, threadId, tabId, maxWidth: 1, maxHeight: 1 },
              {
                onFrame: () => {},
                onViewport: () => {},
                onConnectedChange: () => {},
                onUnauthorized: () =>
                  reject(
                    new BrowserActionError({
                      message: "Browser access expired. Reopen the tab actions and try again.",
                    }),
                  ),
                onGone: () =>
                  reject(new BrowserActionError({ message: "This browser tab was closed." })),
                onHostSetup: (setup) =>
                  reject(new BrowserActionError({ message: previewStreamHostSetupMessage(setup) })),
                onProbe: () => {
                  if (!sentAction || completed) return;
                  completed = true;
                  resolve();
                },
                onControl: (control) => {
                  if (completed) return;
                  try {
                    check();
                    if (!control.canOperate)
                      throw new BrowserActionError({
                        message: "This connection has read-only browser access.",
                      });
                    if (control.controller !== "you") {
                      if (!takingControl) {
                        takingControl = true;
                        if (!client?.send({ type: "takeControl" }))
                          throw new BrowserActionError({
                            message: "Could not request browser control.",
                          });
                      }
                      return;
                    }
                    if (sentAction) return;
                    if (!client?.send(input))
                      throw new BrowserActionError({
                        message: "The browser connection closed before the action was sent.",
                      });
                    sentAction = true;
                    // A read-only probe drains the preceding viewer action before its socket closes.
                    if (!client.send({ type: "probe", x: 0, y: 0 }))
                      throw new BrowserActionError({
                        message:
                          "Could not confirm the browser action. Reopen the tab to check its state.",
                      });
                  } catch (error) {
                    completed = true;
                    reject(error);
                  }
                },
              },
            );
          }),
        catch: (error) =>
          isBrowserActionError(error)
            ? error
            : new BrowserActionError({
                message: error instanceof Error ? error.message : String(error),
              }),
      }).pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () =>
            Effect.fail(
              new BrowserActionError({
                message:
                  "The browser did not confirm the action. Reopen the tab to check its state.",
              }),
            ),
        }),
      ),
    );
  } finally {
    completed = true;
    client?.stop();
  }
}
