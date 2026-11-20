import { expect, it } from "vite-plus/test";
import { derivePanelLayout } from "./panel-layout.ts";

const preferred = {
  sidebarOpen: true,
  workspaceOpen: true,
  chat: true,
  sidebarWidth: 70,
  workspaceWidth: 80,
};

it("keeps a usable conversation while clamping both panels, restoring preferred sizes after resize", () => {
  const narrow = derivePanelLayout({ ...preferred, columns: 132 });
  expect(narrow).toEqual({
    sidebarWidth: 42,
    workspaceWidth: 42,
    mainWidth: 48,
    headerWidth: 90,
    showSidebar: true,
    showWorkspace: true,
  });
  expect(derivePanelLayout({ ...preferred, columns: 220 })).toMatchObject({
    sidebarWidth: 70,
    workspaceWidth: 80,
    mainWidth: 70,
  });
  for (const columns of [0, 40, 85, 86, 100, 131, 132, 180, 220, 320]) {
    const layout = derivePanelLayout({ ...preferred, columns });
    expect(layout.sidebarWidth + layout.mainWidth + layout.workspaceWidth).toBe(columns);
    expect(layout.mainWidth).toBeGreaterThanOrEqual(Math.min(columns, 48));
    expect(layout.showSidebar).toBe(columns >= 86);
    expect(layout.showWorkspace).toBe(columns >= 132);
  }
});

it("reserves space only for visible panels and keeps manual width independent of automatic sizing", () => {
  expect(derivePanelLayout({ ...preferred, columns: 132, workspaceOpen: false })).toMatchObject({
    sidebarWidth: 70,
    workspaceWidth: 0,
    mainWidth: 62,
  });
  expect(derivePanelLayout({ ...preferred, columns: 132, chat: false })).toMatchObject({
    sidebarWidth: 70,
    workspaceWidth: 0,
    showWorkspace: false,
  });
  expect(derivePanelLayout({ ...preferred, columns: 180, sidebarOpen: false })).toMatchObject({
    sidebarWidth: 0,
    workspaceWidth: 80,
    mainWidth: 100,
  });
  expect(derivePanelLayout({ ...preferred, columns: 220, workspaceWidth: null })).toMatchObject({
    workspaceWidth: 57,
    mainWidth: 93,
  });
  expect(derivePanelLayout({ ...preferred, columns: 280, workspaceWidth: null })).toMatchObject({
    workspaceWidth: 80,
    mainWidth: 130,
  });
  expect(derivePanelLayout({ ...preferred, columns: 280 })).toMatchObject({
    workspaceWidth: 80,
    mainWidth: 130,
  });
});
