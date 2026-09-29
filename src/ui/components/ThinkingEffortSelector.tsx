import React, { useCallback, useEffect, useRef, useState } from "react";
import type { SidebarTheme } from "../theme";
import { TRANSITION, useAnimatedMount } from "../animations";

export type ThinkingEffort = "none" | "low" | "medium" | "high" | "xhigh";

export interface ThinkingEffortSelectorProps {
  value: ThinkingEffort;
  theme: SidebarTheme;
  isZh: boolean;
  onChange: (effort: ThinkingEffort) => void;
}

interface EffortOption {
  value: ThinkingEffort;
  labelEn: string;
  labelZh: string;
  color: string;
}

const EFFORT_OPTIONS: EffortOption[] = [
  { value: "none", labelEn: "None", labelZh: "关闭", color: "#94a3b8" },
  { value: "low", labelEn: "Low", labelZh: "低", color: "#60a5fa" },
  { value: "medium", labelEn: "Medium", labelZh: "中", color: "#34d399" },
  { value: "high", labelEn: "High", labelZh: "高", color: "#fbbf24" },
  { value: "xhigh", labelEn: "Extra High", labelZh: "极高", color: "#f87171" },
];

const BrainIcon: React.FC<{ size?: number }> = ({ size = 12 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
    <path d="M10 21h4" />
    <path d="M9 17h6" />
  </svg>
);

export const ThinkingEffortSelector: React.FC<ThinkingEffortSelectorProps> = ({
  value,
  theme,
  isZh,
  onChange,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { mounted, style: animStyle } = useAnimatedMount(isOpen);

  const current = EFFORT_OPTIONS.find((o) => o.value === value) || EFFORT_OPTIONS[0];

  const handleSelect = useCallback(
    (effort: ThinkingEffort) => {
      onChange(effort);
      setIsOpen(false);
    },
    [onChange],
  );

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    (globalThis as any).document.addEventListener("mousedown", handleClickOutside);
    return () => (globalThis as any).document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  return (
    <div
      className="zotero-webai-thinking-selector"
      ref={containerRef}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        className="zotero-webai-thinking-trigger"
        onClick={() => setIsOpen((v) => !v)}
        title={isZh ? "思考强度" : "Thinking depth"}
        style={{
          alignItems: "center",
          appearance: "none",
          background: "transparent",
          border: `1px solid ${theme.thinkingBorder}`,
          borderRadius: 6,
          color: theme.mutedText,
          cursor: "pointer",
          display: "inline-flex",
          fontSize: 11,
          gap: 3,
          height: 24,
          padding: "0 6px",
          transition: TRANSITION.fast,
        }}
      >
        <BrainIcon />
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: current.color,
            flexShrink: 0,
          }}
        />
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" style={{ opacity: 0.5 }}>
          <path d="M2 5L4 3L6 5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {mounted && (
        <div
          className="zotero-webai-thinking-dropdown"
          style={{
            ...animStyle,
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 0,
            background: theme.modelSelectorBackground,
            border: `1px solid ${theme.modelSelectorBorder}`,
            borderRadius: 10,
            boxShadow: theme.dropdownShadow,
            display: "flex",
            flexDirection: "column",
            minWidth: 150,
            overflow: "hidden",
            padding: 4,
            zIndex: 100,
          }}
        >
          <div
            className="zotero-webai-thinking-dropdown-title"
            style={{
              color: theme.mutedText,
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.05em",
              padding: "4px 8px 2px",
              textTransform: "uppercase",
            }}
          >
            {isZh ? "思考深度" : "Thinking depth"}
          </div>
          {EFFORT_OPTIONS.map((option) => (
            <div
              key={option.value}
              className="zotero-webai-thinking-option"
              data-selected={option.value === value ? "true" : undefined}
              onClick={() => handleSelect(option.value)}
              style={{
                alignItems: "center",
                borderRadius: 6,
                cursor: "pointer",
                display: "flex",
                fontSize: 12,
                gap: 6,
                padding: "5px 8px",
                transition: TRANSITION.fast,
                background:
                  option.value === value
                    ? theme.selectionHighlight
                    : "transparent",
                fontWeight: option.value === value ? 600 : 400,
                color: theme.text,
              }}
            >
              <span
                className="zotero-webai-thinking-effort-dot"
                data-level={option.value}
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: option.color,
                  flexShrink: 0,
                }}
              />
              {isZh ? option.labelZh : option.labelEn}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
