# T3 Code terminal client

A terminal surface for T3 Code, using OpenCode's MIT-licensed presentation components and OpenTUI. T3 owns projects, conversations, provider processes, permissions, checkpoints and scheduled work. This app does not embed the OpenCode agent harness or translate T3 state into OpenCode sessions.

## Run

Install the repository dependencies with `vp i`. The terminal client requires Bun 1.3.14 or newer, including when built, because OpenTUI uses Bun's native integration. Run `vp run tui` from the repository root to open onboarding or reconnect to a saved environment.

```sh
cd apps/tui
vp run dev -- --connect http://localhost:3773
```

Connect to the actual address of an existing T3 server. For a local development server, start `vp run dev` from the repository root and use the server address printed by the development runner. Do not point another server at an installed T3 database.

Pair a remote server with a fresh pairing URL from that server:

```sh
vp run dev -- --pair 'PAIRING_URL'
```

`T3_TUI_URL` selects the default address. `T3_TUI_TOKEN` supplies an existing bearer credential without putting it on the command line. `--config-dir DIR` selects terminal-client connection storage. Credentials belong in that private client storage, never the repository.

`vp run dev -- --demo` opens offline example data for exploring the interface. A demo does not verify a server connection or provider execution. `vp run build` creates `dist/index.js`, which runs with `bun dist/index.js`. `bin/t3-tui` launches the source client.

## Use

Press **Ctrl+P** for the command palette, **Ctrl+T** to select a thread, **Ctrl+N** for a new thread and **Ctrl+Q** to exit. Pickers support typing to filter, arrow keys, Enter and Escape. Multi-line forms apply with **Ctrl+S** or **F2**; Enter inserts a line break. Ctrl+Enter also applies when the terminal reports it separately.

The chat surface provides project and thread selection, conversation history and live updates, message composition, model selection, interrupt, approvals and structured question responses. It uses T3's shared client runtime and the same server contracts as the other clients.

The command palette also exposes common operations as editable request forms. These use the selected thread's workspace on the connected environment. Fill empty required fields, review the request, then apply it. Contract validation rejects malformed requests; destination-environment permissions remain authoritative.

| Area           | Curated request forms                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Threads        | Search, archive/restore, settle/reopen, pin/unpin, snooze/unsnooze, mark unread, rename, fork, permission and interaction modes |
| Source control | Working tree diff, commits, status stream, branches, worktree create/remove, pull, selected-file commit, push                   |
| Files          | Directory entries, filename and content search, text read/write                                                                 |
| Checkpoints    | Turn diff and checkpoint restoration by scope and checkpoint ID                                                                 |
| Terminal       | Interactive remote shell, resize, detach/reattach, plus shell management forms                                                  |
| Schedules      | Live task list, create/edit, enable/disable, run now and delete                                                                 |
| Environment    | Settings read/update, provider refresh, linked environments, host resources, storage and usage                                  |

The service inspector exposes the server's remaining typed operations, including provider installation and authentication, pull requests, issues, MCP resources, background work, and additional orchestration commands. Select an operation, edit its payload, and inspect its result or subscribe to its stream. For schedules, reuse a task's returned object and ID when editing an existing task. Creating a task from the curated form starts it disabled.

## Coverage and limits

This is an additional client, so existing web, desktop and mobile clients remain available. The service inspector provides terminal access to API operations; it is a request editor, not a dedicated interface for each feature. The table distinguishes curated forms from the remaining inspector workflows. **Open terminal** attaches your terminal directly to T3's remote PTY; Ctrl+] returns to chat and leaves the shell running.

The connection palette supports direct pairing, saved environments, and managed SSH using T3's existing remote launcher. SSH passwords are masked and are not saved. T3 Connect device login and account discovery are implemented, but the official relay currently rejects its OAuth token at the DPoP bootstrap exchange. Until that upstream relay path accepts CLI OAuth tokens, use direct pairing or SSH to reach the host. External account authorization and real SSH hosts are not exercised by the local test suite.

Browser and device administration can use the underlying services, but browser pixels, graphical device mirroring, screen-region capture, native window controls, rich office-document layout and visual media playback require a graphical client. Text files, paths, metadata, patches and machine-readable service results are inspectable in the terminal. External provider OAuth pages can still require a browser to complete authentication.

OpenCode plugin APIs, OpenCode agent configuration and OpenCode-specific provider/session state are not part of this client. Configure agents and providers through T3.

## Development

```sh
vp run typecheck
vp test run
vp run build
```

Before publishing changes, run `vp run check:changed` from the repository root. Exercise real server flows against isolated development state; offline demo data and a successful build do not prove authentication, streaming, permissions or provider execution.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and [LICENSE.opencode](./LICENSE.opencode) for the exact upstream source revision and license notice.
