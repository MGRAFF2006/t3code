import { describe, expect, it, vi } from "vite-plus/test";
import type { ChatGptHandoffState, ChatGptTransferredProfile } from "@t3tools/contracts";
import { startChatGptTransfer } from "./chatgpt.logic.ts";

const profile: ChatGptTransferredProfile = {
  registration: { clientId: "oaiapp_test" },
  credentials: {
    clientId: "oaiapp_test",
    accessToken: "test-access",
    refreshToken: null,
    idToken: "test-id",
    issuer: "https://test.invalid",
    expiresAt: 1,
    earliestRefreshAt: null,
    scopes: [],
    subject: "test-user",
    email: null,
  },
};

describe("native ChatGPT profile handoff", () => {
  it.each(["close", "destination-change"] as const)(
    "does not import a completed profile after %s",
    async (change) => {
      let receive: (state: ChatGptHandoffState) => void = () => {};
      let current = true;
      const stop = vi.fn();
      const importProfile = vi.fn(async () => {});
      const done = vi.fn();
      const error = vi.fn();
      const close = startChatGptTransfer({
        current: () => current,
        subscribe: (next) => {
          receive = next;
          return stop;
        },
        importProfile,
        onAuth: () => {},
        onFinished: done,
        onError: error,
      });
      receive({ phase: "finished", profile });
      if (change === "close") close();
      else current = false;
      await Promise.resolve();
      expect(importProfile).not.toHaveBeenCalled();
      close();
      expect(stop).toHaveBeenCalledOnce();
      expect(done).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );

  it("imports a finished profile once and releases its source stream", async () => {
    let receive: (state: ChatGptHandoffState) => void = () => {};
    const stop = vi.fn();
    const { promise: finished, resolve } = Promise.withResolvers<void>();
    const importProfile = vi.fn(async () => {});
    const close = startChatGptTransfer({
      current: () => true,
      subscribe: (next) => {
        receive = next;
        return stop;
      },
      importProfile,
      onAuth: () => {},
      onFinished: resolve,
      onError: () => {
        throw new Error("Unexpected failure");
      },
    });
    receive({ phase: "finished", profile });
    receive({ phase: "finished", profile });
    await finished;
    close();
    expect(importProfile).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
