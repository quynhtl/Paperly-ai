import React, { useCallback } from "react";
import { type SidebarTheme, type ThemeMode } from "../theme";
import { TRANSITION } from "../animations";

export interface ThemeToggleProps {
  isDark: boolean;
  theme: SidebarTheme;
  isZh: boolean;
  onToggle: (mode: ThemeMode) => void;
}

const SunIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

const MoonIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

/**
 * Light and dark, with nothing in between.
 *
 * It used to cycle auto -> light -> dark. With the host already dark, "auto"
 * and "dark" painted the same panel, so one press in three visibly did
 * nothing. Preferences still offers Follow system; this reads whatever that
 * resolved to and switches away from it, which is the only thing a press in
 * the header can mean. The icon shows the theme you are in, the tooltip the
 * one you would get.
 */
export const ThemeToggle: React.FC<ThemeToggleProps> = ({
  isDark,
  theme,
  isZh,
  onToggle,
}) => {
  const handleClick = useCallback(() => {
    onToggle(isDark ? "light" : "dark");
  }, [isDark, onToggle]);

  const label = isDark
    ? isZh
      ? "切换到浅色模式"
      : "Switch to light mode"
    : isZh
      ? "切换到深色模式"
      : "Switch to dark mode";

  return (
    <button
      className="zotero-webai-theme-toggle"
      onClick={handleClick}
      title={label}
      aria-label={label}
      aria-pressed={isDark}
      style={{
        alignItems: "center",
        appearance: "none",
        background: "transparent",
        border: 0,
        borderRadius: 6,
        color: theme.mutedText,
        cursor: "pointer",
        display: "inline-flex",
        height: 26,
        justifyContent: "center",
        padding: 0,
        transition: TRANSITION.fast,
        width: 26,
      }}
    >
      {isDark ? <MoonIcon /> : <SunIcon />}
    </button>
  );
};
