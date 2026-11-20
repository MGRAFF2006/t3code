export function derivePanelLayout(options: {
  columns: number;
  sidebarOpen: boolean;
  workspaceOpen: boolean;
  chat: boolean;
  sidebarWidth: number;
  workspaceWidth: number | null;
}) {
  const columns = Math.max(0, Math.floor(options.columns));
  const showSidebar = options.sidebarOpen && columns >= 86;
  const showWorkspace = options.workspaceOpen && options.chat && columns >= 132;
  const sidebarWidth = showSidebar
    ? Math.min(Math.max(22, options.sidebarWidth), 1000, columns - 48 - (showWorkspace ? 42 : 0))
    : 0;
  const headerWidth = columns - sidebarWidth;
  const workspaceWidth = showWorkspace
    ? Math.min(
        Math.max(42, options.workspaceWidth ?? Math.round(headerWidth * 0.38)),
        1000,
        headerWidth - 48,
      )
    : 0;
  return {
    sidebarWidth,
    workspaceWidth,
    mainWidth: headerWidth - workspaceWidth,
    headerWidth,
    showSidebar,
    showWorkspace,
  };
}
