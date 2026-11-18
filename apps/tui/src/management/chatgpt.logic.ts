import type {
  ChatGptHandoffState,
  ChatGptTransferredProfile,
  ProviderAuthState,
} from "@t3tools/contracts";

export function startChatGptTransfer(options: {
  current: () => boolean;
  subscribe: (receive: (state: ChatGptHandoffState) => void, fail: () => void) => () => void;
  importProfile: (profile: ChatGptTransferredProfile) => Promise<void>;
  onAuth: (state: ProviderAuthState) => void;
  onFinished: () => void;
  onError: () => void;
}) {
  let active = true;
  let importing = false;
  let stop: (() => void) | undefined;
  const close = () => {
    if (!active) return;
    active = false;
    stop?.();
  };
  const current = () => active && options.current();
  const fail = () => {
    if (!current()) {
      close();
      return;
    }
    options.onError();
    close();
  };
  stop = options.subscribe((state) => {
    if (!current()) {
      close();
      return;
    }
    if (state.phase === "auth") {
      if (!importing) options.onAuth(state.state);
      return;
    }
    if (importing) return;
    importing = true;
    void Promise.resolve()
      .then(async () => {
        if (!current()) return;
        await options.importProfile(state.profile);
        if (current()) options.onFinished();
      })
      .catch(fail)
      .finally(close);
  }, fail);
  if (!active) stop();
  return close;
}
