# T3 Code terminal client

A native terminal client for T3 Code. Projects, conversations, provider processes, permissions, checkpoints and scheduled work belong to the existing T3 server. The interface follows T3's layout, colors and workflows, using OpenTUI and selected MIT-licensed OpenCode presentation components. It does not include OpenCode's agent harness, server or session database.

## Run

Install this fork's repository dependencies with `vp i`. Bun 1.3.14 or newer is required, including for the built client. From the repository root:

```sh
./apps/tui/bin/t3-tui
```

`vp run tui` is equivalent when Vite+ is on your PATH. The launcher above works directly from this checkout.

On first launch, choose **Pair environment** and paste a fresh pairing URL from your T3 server. You can also pair at launch:

```sh
./apps/tui/bin/t3-tui --pair 'PAIRING_URL'
```

Use `--connect http://HOST:PORT` to select a server, reusing saved credentials for that environment. `T3_TUI_URL` supplies the default address and `T3_TUI_TOKEN` supplies an existing bearer credential without putting it in shell history. `--config-dir DIR` selects private terminal-client storage. Connection credentials and terminal preferences are stored separately there.

`--thread ID` opens a conversation. `--demo` shows the offline interface; it does not verify a connection or provider execution. From `apps/tui`, `vp run build` creates `dist/index.js`, runnable with `bun dist/index.js`. `bin/t3-tui` launches the source client.

For local development, start `vp run dev` separately and use the server address printed by its runner. Keep development state isolated; never start another server against an installed T3 database.

## Navigate

The left sidebar lists threads across projects, using T3's shared pinned and active ordering. Its filter includes Working, Active, Settled, Snoozed and Archived. The header's **Views** menu switches between conversation, workspace, pull requests, issues, scheduled tasks, settings and browser. Conversation stays central; Changes, Files, Git, Browser, Terminals and Devices can open alongside it on wide terminals or fill the main pane on smaller ones. Right-click a thread for its actions. **Ctrl+P** searches commands, including project creation/settings and server conversation search.

Sidebar search and **Ctrl+K** use T3's desktop matching for titles, projects, branches and pull requests. Search spans the selected environment's non-archived shelves; clearing it restores the sidebar filter. Message-history matches appear under **In messages** with a snippet and open find at the matching message. Message search needs a word of at least three letters, or two for Chinese, Japanese and Korean. Press Escape to clear sidebar search.

Drag either sidebar's divider to resize it. For exact widths, right-click a divider, use **Ctrl+P → Panel widths**, or open **Settings → Terminal → Panel widths**. Widths are saved for this terminal client. Smaller windows temporarily constrain them to leave room for the conversation; expanding the window restores your preferred sizes. The right panel also supports automatic sizing. **Reset panel widths** restores both defaults.

A red **●** on a thread, its header or the Terminals view means a command is running in one of its terminals; a number counts busy terminals. Click the indicator, or use **Ctrl+P → Show thread terminals**, to view its sessions. An idle shell has no red indicator. Activity follows the selected environment and clears when a command stops or terminal access is unavailable.

| Shortcut | Action                                                                        |
| -------- | ----------------------------------------------------------------------------- |
| Ctrl+K   | Switch thread                                                                 |
| Ctrl+N   | New thread                                                                    |
| Ctrl+B   | Show/hide sidebar; open thread picker in narrow windows                       |
| Ctrl+E   | Show/hide workspace panel                                                     |
| Ctrl+T   | Attach the thread's interactive terminal                                      |
| F6       | Move focus between panes                                                      |
| Alt+1…7  | Threads, Workspace, Pull requests, Issues, Scheduled tasks, Settings, Browser |
| F1       | Keyboard help                                                                 |
| Ctrl+Q   | Quit                                                                          |

Pickers support search, arrows, Enter, Escape and the mouse. Forms use Tab to change fields, arrows to choose options, and **Ctrl+S** or **F2** to apply. Multiline form fields use Enter for a new line. Focused fields scroll into view.

In conversation, Enter sends and **Alt+Enter** inserts a line break; enhanced keyboards also support Shift+Enter. **F2** opens delivery choices, including sending to multiple models in separate worktrees. **F3** manages local attachments and **F4** opens saved prompts. Ctrl+F searches the current conversation, Ctrl+G moves to the next match and Ctrl+Shift+G moves back. Ctrl+A selects all text in the focused input or editor. `/requests` focuses approvals and questions; In conversation, Ctrl+A outside an editor also focuses requests. Ctrl+J manages queued messages, Ctrl+O opens the work log, and Ctrl+X stops a turn. PageUp/PageDown scroll history; Ctrl+Home/End jumps to its ends. Settings → Terminal changes sending, follow-up delivery, icons, wrapping, diff layout and dark/light theme.

Consecutive tool and reasoning activity collapses into a work group. Expand a group or individual item to read its details and live command output; **Expand work** opens all groups. Messages, requests, plans and important notices remain separate. Drafts and saved prompts persist privately on this computer. `/clear` starts fresh agent context on the next send; `/compact` compacts the current context when the provider supports it.

**Ctrl+T** hands the terminal directly to T3's PTY. **Ctrl+]** returns to the interface and leaves that shell running. Project scripts use separate terminal sessions so they do not inject commands into an existing foreground process.

## Workflows

Provider and conversation warnings offer recovery actions through **Actions**, **Recovery**, or `/status` followed by Tab. Open the selected provider's setup, refresh its status, inspect the full error, or restore a dismissed notice. For usage limits, **Resume at reset** and **Snooze until reset** are independent choices; **Cancel auto-resume** and **Wake now** reverse them. ChatGPT account usage management opens in your browser.

| Area              | Native terminal controls                                                                                                                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Projects          | Open/create/clone, cloning progress/cancel/retry, rename/pin/archive, defaults and inherited settings, scripts and roles, submodules, publishing                                                                                                                                                                                        |
| Threads           | Active/settled/snoozed/archived views, pins, server message search, rename/fork/tags/unread, automatic settling, session restart, title regeneration, deletion, history import, family/context transfer, guest sharing and conversion to a project                                                                                      |
| Conversation      | Streaming Markdown, expandable reasoning/tools/subagents, complete output, plans, approvals, questions and multiselect answers, secret requests, context usage, model/options/permissions, skills/slash commands and structured file mentions                                                                                           |
| Composition       | Durable scoped drafts and saved prompts, multi-model worktree sends, local file/image attachments, rich context, bounded uploads, queue/steer/restart, queued-message attachment edit/reorder/cancel/pause/resume                                                                                                                       |
| Files and changes | Lazy file tree, ignored-file and regex content search, syntax preview/editor, Markdown, CSV/TSV and cached notebook previews, hex inspection, file versions, conflict/truncation guards and checkpoint review/restore                                                                                                                   |
| Git               | Live status, selected-file commits with progress, push/pull, branches, worktrees and setup logs/cancellation, initialization, PR creation and checkout                                                                                                                                                                                  |
| Pull requests     | Search, details/checks/activity, paged per-file diffs, inline/general reviews and comments, review replies/resolution, viewed flags, labels/reviewers, linked threads, review guides/stacks/routing, reactions and provider-permitted lifecycle actions                                                                                 |
| Issues            | Search/create, details, comments, editing, state, labels, assignees and reactions                                                                                                                                                                                                                                                       |
| Scheduled tasks   | Create/edit/run/enable/disable/delete; interval, daily/weekly, one-time and webhook triggers; delivery history and webhook configuration                                                                                                                                                                                                |
| Settings          | Providers/auth/install/configuration, models and environment variables, connections, usage/pricing/history, storage/maintenance/diagnostics/update controls, access grants/revocation, secret sources, integrations, ACP Registry, quotas and reset credits, ChatGPT profile handoff, server keybindings and local terminal preferences |
| Browser           | Shared browser sessions, discovered servers, profile IDs, native navigation and cache controls, viewport/appearance/zoom/reload/close controls and explicit opening in this device's browser                                                                                                                                            |

Workspace also exposes named terminal sessions, device hosts and device actions. **Open workspace in environment editor**, and the corresponding Files action, launch an available editor on the computer hosting that environment. External-viewer actions download a bounded private copy and open it on this computer.

Capabilities and permissions come from the destination environment and provider. The terminal uses T3's existing client commands and contracts; it does not make unsupported provider operations available by pretending they succeeded. Unsaved file edits require an explicit discard before navigation. Resizing preserves an open editor.

## Graphics and newer terminals

Settings → Terminal → **Icons** offers Auto, Nerd Font and Plain. Auto uses the bundled symbol fallbacks in [Ghostty](https://ghostty.org/docs/config) and [WezTerm](https://wezterm.org/config/fonts.html), and plain symbols elsewhere. Choose Nerd Font if your terminal already has one. The setup menu includes a sample and an optional link to [font downloads](https://www.nerdfonts.com/font-downloads); select the installed font in your terminal settings. Remote connections use your local terminal’s font. `T3_TUI_ICONS=auto|nerd|plain` overrides the saved preference.

The application remains native text UI. Images are expanded on demand using OpenTUI's detected **Kitty graphics** or **Sixel** support, with a block preview fallback. This works for conversation attachments, tool images and image files in the workspace. Signed assets are fetched from their owning environment with a streamed 20 MiB preview limit. Local attachments have T3's image/file/count limits and are read only when sent.

**Terminal capabilities** in the command palette reports detected keyboard, graphics, clipboard, hyperlinks, synchronized output and multiplexer support. Copy actions use **OSC52** only when invoked; terminals may require clipboard permission. Browser session links use terminal hyperlinks where supported. Ordinary keys, mouse controls and block previews remain available when enhancements are absent.

OpenTUI detects these features; see its [capability reference](https://opentui.com/docs/reference/terminal-capabilities/). Launch overrides supported by the bundled version include:

```sh
OPENTUI_IMAGE_PROTOCOL=blocks ./apps/tui/bin/t3-tui
OPENTUI_GRAPHICS=0 ./apps/tui/bin/t3-tui
```

`OPENTUI_IMAGE_PROTOCOL` also accepts `auto`, `kitty` and `sixel`. Multiplexers can limit graphics, enhanced keys or clipboard forwarding even when the outer terminal supports them.

Complete HTML responses provide an **Open HTML in browser** action. It creates a private temporary HTML file and opens it only on request. Shared browser tabs also offer **Open URL in this device's browser**. A remote host's loopback URL may need port forwarding; a local browser does not inherit that host's filesystem, cookies or network access.

Electron can render a BrowserWindow into a bitmap using [offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering). Feeding those frames to the image renderer is feasible as a separate visual source, but requires a Chromium host and input/coordinate integration. This client does not rasterize the T3 interface or embed an Electron process. Its conversation, navigation, editor and controls remain native.

## Coverage and remaining limits

The [desktop compatibility audit](https://github.com/MGRAFF2006/t3code-tui/issues/1) uses desktop features as its target and records native controls, explicit graphical handoffs, missing behavior and verification evidence separately. The command palette’s **Developer → Service inspector** retains typed access to less common operations; this is an advanced request editor, not dedicated interface parity.

Remaining gaps include editing/resending dispatched messages, a durable offline send queue, exact inline search highlighting, dictation, custom themes and remapping the terminal’s own shortcuts. Advanced PR review controls, some connection-host administration and embedded MCP app interfaces also remain partial. Server web/desktop keybindings can be edited here; they do not remap TUI controls.

Shared browser interaction and device display/input remain missing from this client. Opening a browser URL locally does not carry the shared browser's profile or session. Device management controls do not open a simulator view. Desktop window/tray controls and screen-selection gestures also remain unavailable. Text/source, supported image assets and cached notebook cells render natively; executable notebook output, office-document layout and media playback use explicit external viewers. The terminal owns fonts and opacity. Interface text is currently English; server/provider content retains its original language.

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
