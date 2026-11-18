# T3 Code terminal client

A native terminal client for T3 Code. Projects, conversations, provider processes, permissions, checkpoints and scheduled work belong to the existing T3 server. The interface follows T3's layout, colors and workflows, using OpenTUI and selected MIT-licensed OpenCode presentation components. It does not include OpenCode's agent harness, server or session database.

## Run

Install this fork's repository dependencies with `vp i`. Bun 1.3.14 or newer is required, including for the built client. From the repository root:

```sh
vp run tui
```

On first launch, choose **Pair environment** and paste a fresh pairing URL from your T3 server. You can also pair at launch:

```sh
vp run tui -- --pair 'PAIRING_URL'
```

Use `--connect http://HOST:PORT` to select a server, reusing saved credentials for that environment. `T3_TUI_URL` supplies the default address and `T3_TUI_TOKEN` supplies an existing bearer credential without putting it in shell history. `--config-dir DIR` selects private terminal-client storage. Connection credentials and terminal preferences are stored separately there.

`--thread ID` opens a conversation. `--demo` shows the offline interface; it does not verify a connection or provider execution. From `apps/tui`, `vp run build` creates `dist/index.js`, runnable with `bun dist/index.js`. `bin/t3-tui` launches the source client.

For local development, start `vp run dev` separately and use the server address printed by its runner. Keep development state isolated; never start another server against an installed T3 database.

## Navigate

The left sidebar lists threads across projects, using T3's shared pinned and active ordering. The header's **Views** menu switches between conversation, workspace, pull requests, issues, scheduled tasks, settings and browser. Conversation stays central; Changes, Files, Git and Browser can open alongside it on wide terminals or fill the main pane on smaller ones. Right-click a thread for its actions. **Ctrl+P** searches commands, including project creation/settings and server conversation search.

| Shortcut | Action                                                                        |
| -------- | ----------------------------------------------------------------------------- |
| Ctrl+K   | Switch thread                                                                 |
| Ctrl+N   | New thread                                                                    |
| Ctrl+B   | Show/hide sidebar                                                             |
| Ctrl+E   | Show/hide workspace panel                                                     |
| Ctrl+T   | Attach the thread's interactive terminal                                      |
| F6       | Move focus between panes                                                      |
| Alt+1…7  | Threads, Workspace, Pull requests, Issues, Scheduled tasks, Settings, Browser |
| F1       | Keyboard help                                                                 |
| Ctrl+Q   | Quit                                                                          |

Pickers support search, arrows, Enter, Escape and the mouse. Forms use Tab to change fields, arrows to choose options, and **Ctrl+S** or **F2** to apply. Multiline form fields use Enter for a new line. Focused fields scroll into view.

In conversation, Enter sends and **Alt+Enter** inserts a line break; enhanced keyboards also support Shift+Enter. **F2** opens delivery choices, **F3** manages local attachments, Ctrl+A focuses requests, Ctrl+J manages queued messages, Ctrl+O opens the work log, and Ctrl+X stops a turn. PageUp/PageDown scroll history; Ctrl+Home/End jumps to its ends. Settings → Terminal changes sending, follow-up delivery, wrapping, diff layout and dark/light theme.

**Ctrl+T** hands the terminal directly to T3's PTY. **Ctrl+]** returns to the interface and leaves that shell running. Project scripts use separate terminal sessions so they do not inject commands into an existing foreground process.

## Workflows

| Area              | Native terminal controls                                                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects          | Open/create/clone, cloning progress/cancel/retry, rename/pin/archive, defaults and inherited settings, scripts and roles, submodules, publishing                                                                                              |
| Threads           | Active/settled/snoozed/archived views, pins, server message search, rename/fork/tags/unread, automatic settling, session restart, title regeneration, deletion and conversion to a project                                                    |
| Conversation      | Streaming Markdown, expandable reasoning/tools/subagents, complete output, plans, approvals, questions and multiselect answers, secret requests, context usage, model/options/permissions, skills/slash commands and structured file mentions |
| Composition       | Per-environment/thread drafts, local file/image attachments, bounded uploads, queue/steer/restart, queued-message edit/reorder/cancel/pause/resume                                                                                            |
| Files and changes | Lazy file tree, filename/content search, syntax preview/editor, conflict/truncation guards, working-tree/branch/commit diffs and checkpoint-specific review/restore                                                                           |
| Git               | Live status, selected-file commits with progress, push/pull, branches, worktrees, initialization and PR creation                                                                                                                              |
| Pull requests     | Search, details/checks/activity, paged per-file diffs, inline/general reviews and comments, review replies/resolution, viewed flags, labels/reviewers, linked threads and provider-permitted lifecycle actions                                |
| Issues            | Search/create, details, comments, editing, state, labels and assignees                                                                                                                                                                        |
| Scheduled tasks   | Create/edit/run/enable/disable/delete; interval, daily/weekly, one-time and webhook triggers; delivery history and webhook configuration                                                                                                      |
| Settings          | Providers/auth/install/configuration, models and environment variables, connections, usage/pricing/history, storage/maintenance/diagnostics/update controls, access grants/revocation, secret sources and local terminal preferences          |
| Browser           | Shared browser sessions, discovered servers, profile IDs, viewport/appearance/zoom/reload/close controls and explicit opening in this device's browser                                                                                        |

Capabilities and permissions come from the destination environment and provider. The terminal uses T3's existing client commands and contracts; it does not make unsupported provider operations available by pretending they succeeded. Unsaved file edits require an explicit discard before navigation. Resizing preserves an open editor.

## Graphics and newer terminals

The application remains native text UI. Images are expanded on demand using OpenTUI's detected **Kitty graphics** or **Sixel** support, with a block preview fallback. This works for conversation attachments, tool images and image files in the workspace. Signed assets are fetched from their owning environment with a streamed 20 MiB preview limit. Local attachments have T3's image/file/count limits and are read only when sent.

**Terminal capabilities** in the command palette reports detected keyboard, graphics, clipboard, hyperlinks, synchronized output and multiplexer support. Copy actions use **OSC52** only when invoked; terminals may require clipboard permission. Browser session links use terminal hyperlinks where supported. Ordinary keys, mouse controls and block previews remain available when enhancements are absent.

OpenTUI detects these features; see its [capability reference](https://opentui.com/docs/reference/terminal-capabilities/). Launch overrides supported by the bundled version include:

```sh
OPENTUI_IMAGE_PROTOCOL=blocks vp run tui
OPENTUI_GRAPHICS=0 vp run tui
```

`OPENTUI_IMAGE_PROTOCOL` also accepts `auto`, `kitty` and `sixel`. Multiplexers can limit graphics, enhanced keys or clipboard forwarding even when the outer terminal supports them.

Complete HTML responses provide an **Open HTML in browser** action. It creates a private temporary HTML file and opens it only on request. Shared browser tabs also offer **Open URL in this device's browser**. A remote host's loopback URL may need port forwarding; a local browser does not inherit that host's filesystem, cookies or network access.

Electron can render a BrowserWindow into a bitmap using [offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering). Feeding those frames to the image renderer is feasible as a separate visual source, but requires a Chromium host and input/coordinate integration. This client does not rasterize the T3 interface or embed an Electron process. Its conversation, navigation, editor and controls remain native.

## Coverage and remaining limits

The command palette's **Developer → Service inspector** retains typed access to less common server operations. It is an advanced request editor, not a claim of dedicated UX parity. Session scan/import and context-transfer tools, guest-share configuration, detailed source-control/issue-tracker host setup, linked-environment administration, review-guide/stack/routing controls, and server keybinding customization still use that inspector where their contracts are exposed.

Graphical MCP app contents, interactive browser/device pixels, native desktop window/tray controls and screen-selection gestures retain their web/desktop/mobile surfaces. Text/source and supported image assets can be inspected here; full office-document layout, notebooks and media playback are not native terminal viewers in this version. The terminal owns fonts and opacity. Interface text is currently English; server/provider content retains its original language.

Direct pairing, saved environments and managed SSH use T3's existing connection system. SSH passwords are masked and not saved. T3 Connect device login/account discovery are implemented, but the official relay currently rejects CLI OAuth at DPoP bootstrap; use direct pairing or SSH until that relay path supports it. Real SSH hosts, external provider authorization and forge mutations require their actual accounts and have not been exercised by local fixture tests.

Validation includes native renderer flows and an isolated source server with the free Replay provider. It does not substitute for hardware testing across terminal emulators, multiplexers and operating systems.

## Development

From `apps/tui`:

```sh
vp run typecheck
vp test run
vp run build
```

Before pushing, run `vp run check:changed` from the repository root. Use isolated development state and the free Replay provider for integrated verification.

See [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) and [LICENSE.opencode](./LICENSE.opencode) for the exact source revision and MIT notice.
