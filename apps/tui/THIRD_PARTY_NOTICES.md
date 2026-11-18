# OpenCode presentation components

This terminal client contains presentation code adapted from
[anomalyco/opencode](https://github.com/anomalyco/opencode) at revision
`79bd2c6f11fd5ad011dbe5a1c31343c46e1e5294`:

- `packages/tui/src/ui/select-controller.ts`
- `packages/tui/src/ui/dialog.tsx`
- `packages/tui/src/ui/dialog-select.tsx`
- `packages/tui/src/theme/assets/opencode.json`

The dialog components retain OpenCode's terminal layout, filtered selection,
selection window, and keyboard navigation while replacing its application
contexts with this client's T3 Code state. OpenCode's agent execution,
provider integration, persistence, and HTTP server are not included.

Copyright (c) 2025 opencode. Licensed under the MIT License; the complete
copyright and permission notice is in [LICENSE.opencode](./LICENSE.opencode).
