export type SidebarLocation = "library" | "reader";

export function resolveSidebarLocation(tabType: string): SidebarLocation | null {
  const normalized = `${tabType || ""}`.toLowerCase();
  if (
    normalized === "library" ||
    normalized.includes("library") ||
    isLibraryLikeTabType(normalized)
  ) {
    return "library";
  }
  if (normalized === "reader" || normalized.includes("reader")) {
    return "reader";
  }
  return null;
}

export function isSidebarLocationSelected(
  tabType: string,
  location: SidebarLocation,
): boolean {
  return resolveSidebarLocation(tabType) === location;
}

function isLibraryLikeTabType(tabType: string): boolean {
  return (
    tabType === "collection" ||
    tabType === "collections" ||
    tabType === "item" ||
    tabType === "items" ||
    tabType === "item-tree" ||
    tabType === "zotero-pane"
  );
}
