export interface SidebarTheme {
  background: string;
  panelBackground: string;
  surfaceBackground: string;
  text: string;
  mutedText: string;
  border: string;
  softBorder: string;
  buttonText: string;
  buttonBorder: string;
  noticeBackground: string;
  noticeBorder: string;
  noticeText: string;
  noticeTitle: string;
  warningBackground: string;
  warningBorder: string;
  warningText: string;
  badgeBackground: string;
  badgeBorder: string;
  badgeText: string;
  accentBackground: string;
  accentBorder: string;
  accentText: string;
  errorBackground: string;
  errorBorder: string;
  errorText: string;
  inputBackground: string;
  inputBorder: string;
  userMessageBackground: string;
  userMessageBorder: string;
  assistantMessageBackground: string;
  assistantMessageBorder: string;
  systemMessageBackground: string;
  systemMessageBorder: string;

  // --- New: gradients & brand ---
  primaryGradientStart: string;
  primaryGradientEnd: string;
  brandAccent: string;

  // --- New: interaction states ---
  hoverBackground: string;
  activeBackground: string;
  focusRing: string;

  // --- New: card shadows ---
  cardShadow: string;
  cardShadowHover: string;
  dropdownShadow: string;

  // --- New: transitions ---
  transitionSpeed: string;
  transitionSpeedFast: string;
  transitionSpeedSlow: string;
  transitionEasing: string;

  // --- New: toolbar ---
  toolbarBackground: string;
  toolbarBorder: string;
  toolbarButtonHover: string;

  // --- New: selection ---
  selectionHighlight: string;
  selectionToolbarBackground: string;
  selectionToolbarShadow: string;

  // --- New: thinking display ---
  thinkingBackground: string;
  thinkingBorder: string;
  thinkingText: string;
  thinkingAccent: string;

  // --- New: token usage ---
  tokenBadgeBackground: string;
  tokenBadgeBorder: string;
  tokenBadgeText: string;
  tokenProgressTrack: string;
  tokenProgressFill: string;

  // --- New: model selector ---
  modelSelectorBackground: string;
  modelSelectorBorder: string;
  modelSelectorHover: string;
  modelOnlineIndicator: string;
  modelOfflineIndicator: string;

  // --- New: quick prompts ---
  quickPromptBackground: string;
  quickPromptBorder: string;
  quickPromptHover: string;
  quickPromptText: string;

  // --- New: separator / divider ---
  divider: string;

  // --- New: overlay ---
  overlayBackground: string;

  // --- New: scrollbar ---
  scrollbarTrack: string;
  scrollbarThumb: string;
}

const lightTheme: SidebarTheme = {
  // Original colors preserved
  background: "#f7f7f7",
  panelBackground: "#f6f6f6",
  surfaceBackground: "#ffffff",
  text: "#222222",
  mutedText: "#666666",
  border: "#d7d7d7",
  softBorder: "#e0e0e0",
  buttonText: "#333333",
  buttonBorder: "#c9c9c9",
  noticeBackground: "#faf7ef",
  noticeBorder: "#e4dac0",
  noticeText: "#6f6138",
  noticeTitle: "#5d4d23",
  warningBackground: "#f7f3e6",
  warningBorder: "#e5dcc0",
  warningText: "#7b5d17",
  badgeBackground: "#edf4fb",
  badgeBorder: "#d6e5f4",
  badgeText: "#2a5a86",
  accentBackground: "#f7f1dc",
  accentBorder: "#e7dfc3",
  accentText: "#6d5a1f",
  errorBackground: "#fbf1f1",
  errorBorder: "#ead2d2",
  errorText: "#8d3838",
  inputBackground: "#ffffff",
  inputBorder: "#d4d4d4",
  userMessageBackground: "#eaffea",
  userMessageBorder: "#d3efd3",
  assistantMessageBackground: "#f1f1f1",
  assistantMessageBorder: "#e1e1e1",
  systemMessageBackground: "#f6f6f6",
  systemMessageBorder: "#e1e1e1",

  // New properties
  primaryGradientStart: "#6366f1",
  primaryGradientEnd: "#8b5cf6",
  brandAccent: "#6366f1",

  hoverBackground: "rgba(0, 0, 0, 0.04)",
  activeBackground: "rgba(0, 0, 0, 0.08)",
  focusRing: "rgba(99, 102, 241, 0.4)",

  cardShadow: "0 1px 3px rgba(0, 0, 0, 0.06), 0 1px 2px rgba(0, 0, 0, 0.04)",
  cardShadowHover: "0 4px 12px rgba(0, 0, 0, 0.08), 0 2px 4px rgba(0, 0, 0, 0.04)",
  dropdownShadow: "0 8px 24px rgba(0, 0, 0, 0.12), 0 2px 8px rgba(0, 0, 0, 0.06)",

  transitionSpeed: "200ms",
  transitionSpeedFast: "120ms",
  transitionSpeedSlow: "350ms",
  transitionEasing: "cubic-bezier(0.4, 0, 0.2, 1)",

  toolbarBackground: "#ffffff",
  toolbarBorder: "#e5e5e5",
  toolbarButtonHover: "rgba(0, 0, 0, 0.06)",

  selectionHighlight: "rgba(99, 102, 241, 0.15)",
  selectionToolbarBackground: "#ffffff",
  selectionToolbarShadow: "0 4px 16px rgba(0, 0, 0, 0.14), 0 1px 4px rgba(0, 0, 0, 0.06)",

  thinkingBackground: "#f5f3ff",
  thinkingBorder: "#e0d8f7",
  thinkingText: "#5b21b6",
  thinkingAccent: "#7c3aed",

  tokenBadgeBackground: "#f0fdf4",
  tokenBadgeBorder: "#bbf7d0",
  tokenBadgeText: "#166534",
  tokenProgressTrack: "#e5e7eb",
  tokenProgressFill: "#6366f1",

  modelSelectorBackground: "#ffffff",
  modelSelectorBorder: "#e0e0e0",
  modelSelectorHover: "#f5f5f5",
  modelOnlineIndicator: "#22c55e",
  modelOfflineIndicator: "#ef4444",

  quickPromptBackground: "#f0f0ff",
  quickPromptBorder: "#d8d8f0",
  quickPromptHover: "#e4e4ff",
  quickPromptText: "#4338ca",

  divider: "rgba(0, 0, 0, 0.06)",

  overlayBackground: "rgba(0, 0, 0, 0.3)",

  scrollbarTrack: "transparent",
  scrollbarThumb: "rgba(0, 0, 0, 0.15)",
};

const darkTheme: SidebarTheme = {
  // Original colors preserved
  background: "#26272b",
  panelBackground: "#2d2f34",
  surfaceBackground: "#343740",
  text: "#f2f3f5",
  mutedText: "#c2c7cf",
  border: "#464b55",
  softBorder: "#3d4149",
  buttonText: "#eef1f4",
  buttonBorder: "#575d68",
  noticeBackground: "#403827",
  noticeBorder: "#5d5138",
  noticeText: "#e7d8ad",
  noticeTitle: "#f3e5be",
  warningBackground: "#463a27",
  warningBorder: "#6b5738",
  warningText: "#f0da9d",
  badgeBackground: "#2b3b4d",
  badgeBorder: "#3a536e",
  badgeText: "#cfe1f6",
  accentBackground: "#4a4024",
  accentBorder: "#6a5d36",
  accentText: "#f0e2aa",
  errorBackground: "#4b2d2d",
  errorBorder: "#744545",
  errorText: "#ffd5d5",
  inputBackground: "#23252a",
  inputBorder: "#555b66",
  userMessageBackground: "#253c2f",
  userMessageBorder: "#3f614b",
  assistantMessageBackground: "#303238",
  assistantMessageBorder: "#4a4e57",
  systemMessageBackground: "#383b42",
  systemMessageBorder: "#50555f",

  // New properties
  primaryGradientStart: "#818cf8",
  primaryGradientEnd: "#a78bfa",
  brandAccent: "#818cf8",

  hoverBackground: "rgba(255, 255, 255, 0.06)",
  activeBackground: "rgba(255, 255, 255, 0.1)",
  focusRing: "rgba(129, 140, 248, 0.45)",

  cardShadow: "0 1px 3px rgba(0, 0, 0, 0.2), 0 1px 2px rgba(0, 0, 0, 0.15)",
  cardShadowHover: "0 4px 12px rgba(0, 0, 0, 0.25), 0 2px 4px rgba(0, 0, 0, 0.15)",
  dropdownShadow: "0 8px 24px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.2)",

  transitionSpeed: "200ms",
  transitionSpeedFast: "120ms",
  transitionSpeedSlow: "350ms",
  transitionEasing: "cubic-bezier(0.4, 0, 0.2, 1)",

  toolbarBackground: "#2d2f34",
  toolbarBorder: "#464b55",
  toolbarButtonHover: "rgba(255, 255, 255, 0.08)",

  selectionHighlight: "rgba(129, 140, 248, 0.2)",
  selectionToolbarBackground: "#343740",
  selectionToolbarShadow: "0 4px 16px rgba(0, 0, 0, 0.35), 0 1px 4px rgba(0, 0, 0, 0.2)",

  thinkingBackground: "#2e2543",
  thinkingBorder: "#453770",
  thinkingText: "#c4b5fd",
  thinkingAccent: "#a78bfa",

  tokenBadgeBackground: "#1a332a",
  tokenBadgeBorder: "#2d5f46",
  tokenBadgeText: "#86efac",
  tokenProgressTrack: "#3d4149",
  tokenProgressFill: "#818cf8",

  modelSelectorBackground: "#2d2f34",
  modelSelectorBorder: "#464b55",
  modelSelectorHover: "#3a3d45",
  modelOnlineIndicator: "#4ade80",
  modelOfflineIndicator: "#f87171",

  quickPromptBackground: "#2e2d44",
  quickPromptBorder: "#3f3d5c",
  quickPromptHover: "#3a3858",
  quickPromptText: "#a5b4fc",

  divider: "rgba(255, 255, 255, 0.06)",

  overlayBackground: "rgba(0, 0, 0, 0.5)",

  scrollbarTrack: "transparent",
  scrollbarThumb: "rgba(255, 255, 255, 0.15)",
};

export type ThemeMode = "auto" | "light" | "dark";

export function getSidebarTheme(win?: Window | null, mode?: ThemeMode): SidebarTheme {
  if (mode === "light") {
    return lightTheme;
  }

  if (mode === "dark") {
    return darkTheme;
  }

  // auto or undefined — probe system preference
  try {
    if (win?.matchMedia?.("(prefers-color-scheme: dark)")?.matches) {
      return darkTheme;
    }
  } catch {
    // Ignore host theme probe failures and fall back to light theme.
  }

  return lightTheme;
}

export function isDarkTheme(win?: Window | null, mode?: ThemeMode): boolean {
  if (mode === "dark") {
    return true;
  }
  if (mode === "light") {
    return false;
  }
  try {
    return !!win?.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  } catch {
    return false;
  }
}

/**
 * Generates a CSS transition string using the theme's transition parameters.
 */
export function getThemeTransition(
  properties: string | string[] = "all",
  theme?: SidebarTheme,
): string {
  const speed = theme?.transitionSpeed ?? "200ms";
  const easing = theme?.transitionEasing ?? "cubic-bezier(0.4, 0, 0.2, 1)";
  const props = Array.isArray(properties) ? properties : [properties];
  return props.map((prop) => `${prop} ${speed} ${easing}`).join(", ");
}

/**
 * Returns a CSS gradient string for brand-accent backgrounds.
 */
export function getThemeGradient(
  theme: SidebarTheme,
  direction = "135deg",
): string {
  return `linear-gradient(${direction}, ${theme.primaryGradientStart}, ${theme.primaryGradientEnd})`;
}
