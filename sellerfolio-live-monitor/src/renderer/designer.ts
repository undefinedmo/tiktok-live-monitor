// LANE F — Settings: two tabs (Label designer / Printer & app), the free-layout label designer
// (core/labelLayout: canvas, layers, properties, QR modes, 4×6, logo), and the "Text from the
// title" drawer that hosts the existing regex tools (the Label layout card's preset / sample /
// Advanced pattern controls, moved into #titleDrawer).
//
// Lane F MOVES the label-settings code in renderer.ts (inside the "lane F" fences: LabelTemplate,
// the preview, per-field sizes, saved patterns, setupSettings) into this file.
// Fills: index.html #settingsTabs, #designerTab, #titleDrawer (+ #titleDrawerScrim); CSS block "lane F".
// SCAFFOLD STUB: no-op. Until lane F lands, #designerTab stays hidden and #appTab (the existing
// cards) is what Settings shows.

/** Called once by renderer.ts at startup, after the existing setupSettings(). */
export function initDesigner(): void {}
