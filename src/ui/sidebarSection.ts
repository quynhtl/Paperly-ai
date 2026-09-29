import type { Root } from "react-dom/client";

export type SidebarLocation = "library" | "reader";
export type SidebarHostMount = HTMLElement;
export type SidebarAttachmentTarget =
  | "native-library"
  | "native-reader"
  | "message-head"
  | "section-body"
  | "section-fallback"
  | null;

export interface SidebarSurfaceHost {
  attachmentTarget: SidebarAttachmentTarget;
  mountPoint: SidebarHostMount;
  reactRoot: Root | null;
  reactRootElement: HTMLDivElement;
  bootstrapped: boolean;
  bootstrappingPromise: Promise<void> | null;
}

export type SidebarHostState = Partial<
  Record<SidebarLocation, SidebarSurfaceHost>
>;

type SidebarDocumentFactory = Pick<Document, "createElement"> &
  Partial<Pick<Document, "createElementNS">> & {
    createXULElement?: (tagName: string) => unknown;
  };

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

export function createSectionSidebarHost(
  location: SidebarLocation,
  doc: Pick<Document, "createElement" | "createElementNS">,
): SidebarSurfaceHost {
  return createSidebarHost(
    {
      createElement: doc.createElement.bind(doc),
      createElementNS: doc.createElementNS?.bind(doc),
    },
    location,
  );
}

function createSidebarHost(
  doc: SidebarDocumentFactory,
  location: SidebarLocation,
): SidebarSurfaceHost {
  const mountPoint = (doc.createXULElement?.("vbox") ??
    doc.createElement("div")) as SidebarHostMount;
  mountPoint.id = `ai-assistant-pane-${location}-mount`;
  mountPoint.className = "ai-assistant-pane-mount";

  const reactRootElement = (doc.createElementNS?.(
    "http://www.w3.org/1999/xhtml",
    "div",
  ) ?? doc.createElement("div")) as HTMLDivElement;
  reactRootElement.id = `ai-assistant-pane-${location}`;
  reactRootElement.className = "ai-assistant-pane";
  reactRootElement.dataset.location = location;
  reactRootElement.textContent = "";

  Object.assign(mountPoint.style, sharedHostStyles, {
    display: "flex",
  });
  Object.assign(reactRootElement.style, sharedHostStyles, {
    flexDirection: "column",
    height: "100%",
  });

  mountPoint.appendChild(reactRootElement);

  return {
    attachmentTarget: null,
    mountPoint,
    reactRoot: null,
    reactRootElement,
    bootstrapped: false,
    bootstrappingPromise: null,
  };
}

const sharedHostStyles = {
  display: "flex",
  flex: "1",
  minHeight: "0",
  minWidth: "0",
  maxWidth: "100%",
  boxSizing: "border-box",
};

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
