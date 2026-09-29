import React, { useCallback } from "react";
import type { SidebarTheme } from "../theme";
import { TRANSITION } from "../animations";

export interface SelectionToolbarAction {
  id: string;
  label: string;
  icon: React.ReactNode;
}

export interface SelectionToolbarProps {
  selectedText: string;
  position: { top: number; left: number };
  theme: SidebarTheme;
  isZh: boolean;
  onAction: (actionId: string, selectedText: string) => void;
  onDismiss: () => void;
}

const ExplainIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10" />
    <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
    <line x1="12" y1="17" x2="12.01" y2="17" />
  </svg>
);

const TranslateIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 8l6 6" />
    <path d="M4 14l6-6 2-3" />
    <path d="M2 5h12" />
    <path d="M7 2h1" />
    <path d="M22 22l-5-10-5 10" />
    <path d="M14 18h6" />
  </svg>
);

const SummarizeIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="17" y1="10" x2="3" y2="10" />
    <line x1="21" y1="6" x2="3" y2="6" />
    <line x1="21" y1="14" x2="3" y2="14" />
    <line x1="17" y1="18" x2="3" y2="18" />
  </svg>
);

const AskIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
);

const CopyIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </svg>
);

const ACTIONS_ZH: SelectionToolbarAction[] = [
  { id: "explain", label: "解释", icon: <ExplainIcon /> },
  { id: "translate", label: "翻译", icon: <TranslateIcon /> },
  { id: "summarize", label: "总结", icon: <SummarizeIcon /> },
  { id: "ask", label: "追问", icon: <AskIcon /> },
  { id: "copy", label: "复制", icon: <CopyIcon /> },
];

const ACTIONS_EN: SelectionToolbarAction[] = [
  { id: "explain", label: "Explain", icon: <ExplainIcon /> },
  { id: "translate", label: "Translate", icon: <TranslateIcon /> },
  { id: "summarize", label: "Summarize", icon: <SummarizeIcon /> },
  { id: "ask", label: "Ask", icon: <AskIcon /> },
  { id: "copy", label: "Copy", icon: <CopyIcon /> },
];

export const SelectionToolbar: React.FC<SelectionToolbarProps> = ({
  selectedText,
  position,
  theme,
  isZh,
  onAction,
  onDismiss,
}) => {
  const actions = isZh ? ACTIONS_ZH : ACTIONS_EN;

  const handleAction = useCallback(
    (actionId: string) => {
      if (actionId === "copy") {
        try {
          (globalThis as any).navigator?.clipboard?.writeText(selectedText);
        } catch {
          // Ignore clipboard errors
        }
        onDismiss();
        return;
      }
      onAction(actionId, selectedText);
    },
    [selectedText, onAction, onDismiss],
  );

  return (
    <div
      className="zotero-webai-selection-toolbar"
      style={{
        position: "fixed",
        top: position.top,
        left: position.left,
        transform: "translateX(-50%) translateY(-100%)",
        marginTop: -8,
        zIndex: 9999,
        display: "inline-flex",
        alignItems: "center",
        gap: 2,
        padding: "4px 6px",
        background: theme.selectionToolbarBackground,
        border: `1px solid ${theme.softBorder}`,
        borderRadius: 14,
        boxShadow: theme.selectionToolbarShadow,
        animation: "webai-scale-in 200ms cubic-bezier(0.16, 1, 0.3, 1) both",
      }}
    >
      {actions.map((action, index) => (
        <React.Fragment key={action.id}>
          {index > 0 && index === actions.length - 1 && (
            <div
              className="zotero-webai-selection-toolbar-divider"
              style={{
                width: 1,
                height: 16,
                background: theme.divider,
                margin: "0 2px",
              }}
            />
          )}
          <button
            className="zotero-webai-selection-toolbar-btn"
            onClick={() => handleAction(action.id)}
            title={action.label}
            style={{
              alignItems: "center",
              appearance: "none",
              background: "transparent",
              border: 0,
              borderRadius: 6,
              color: theme.text,
              cursor: "pointer",
              display: "inline-flex",
              fontSize: 12,
              gap: 4,
              height: 28,
              justifyContent: "center",
              minWidth: 28,
              padding: "0 8px",
              transition: TRANSITION.fast,
              whiteSpace: "nowrap",
            }}
          >
            {action.icon}
            <span>{action.label}</span>
          </button>
        </React.Fragment>
      ))}
    </div>
  );
};
