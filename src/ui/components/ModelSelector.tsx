import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SidebarTheme } from "../theme";
import { ANIMATION, TRANSITION, useAnimatedMount } from "../animations";
import {
  hasStoredSession,
  type WebAIService,
  type WebAIServiceKind,
} from "../webAIServices";

export interface ModelSelectorProps {
  hostWindow: Window;
  isZh: boolean;
  onSelect: (service: WebAIService) => void;
  selected: WebAIService;
  services: WebAIService[];
  theme: SidebarTheme;
}

const GROUP_LABELS: Record<WebAIServiceKind, { en: string; zh: string }> = {
  chat: { en: "AI chat", zh: "AI 对话" },
  lookup: { en: "Look up", zh: "查询" },
};

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  hostWindow,
  isZh,
  onSelect,
  selected,
  services,
  theme,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const { mounted, style: animStyle } = useAnimatedMount(isOpen);

  // Each call queries the cookie database, so resolve them once per opening
  // rather than on every render.
  const signedIn = useMemo(() => {
    if (!isOpen) {
      return {} as Record<string, boolean>;
    }
    const result: Record<string, boolean> = {};
    services.forEach((service) => {
      result[service.id] =
        service.kind === "chat" ? hasStoredSession(service) : true;
    });
    return result;
  }, [isOpen, services]);

  const groups = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matches = services.filter((service) =>
      service.label.toLowerCase().includes(needle),
    );
    return (["chat", "lookup"] as WebAIServiceKind[])
      .map((kind) => ({
        kind,
        items: matches.filter((service) => service.kind === kind),
      }))
      .filter((group) => group.items.length > 0);
  }, [filter, services]);

  const close = useCallback(() => {
    setIsOpen(false);
    setFilter("");
  }, []);

  const handleSelect = useCallback(
    (service: WebAIService) => {
      close();
      if (service.id !== selected.id) {
        onSelect(service);
      }
    },
    [close, onSelect, selected.id],
  );

  useEffect(() => {
    if (!isOpen) return;
    const doc = hostWindow.document;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (target && !containerRef.current?.contains(target)) {
        close();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("keydown", onKeyDown, true);
    return () => {
      doc.removeEventListener("pointerdown", onPointerDown, true);
      doc.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close, hostWindow, isOpen]);

  const dotColor = (service: WebAIService): string => {
    if (service.kind === "lookup") {
      return theme.mutedText;
    }
    return signedIn[service.id] === false
      ? "#f59e0b"
      : theme.modelOnlineIndicator;
  };

  return (
    <div
      className="zotero-webai-model-selector"
      ref={containerRef}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        className="zotero-webai-model-selector-trigger"
        onClick={() => (isOpen ? close() : setIsOpen(true))}
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        title={isZh ? "选择 AI 平台" : "Select AI platform"}
        style={{
          background: "transparent",
          border: `1px solid ${theme.modelSelectorBorder}`,
          borderRadius: 6,
          color: theme.text,
          cursor: "pointer",
          fontSize: 12,
          padding: "0 8px",
          height: 26,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          transition: TRANSITION.fast,
        }}
      >
        <span
          className="zotero-webai-model-selector-dot"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            flexShrink: 0,
            background: dotColor(selected),
          }}
        />
        <span
          style={{
            maxWidth: 110,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {selected.label}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="currentColor"
          style={{ opacity: 0.5, flexShrink: 0 }}
        >
          <path
            d="M2.5 3.5L5 6.5L7.5 3.5"
            stroke="currentColor"
            strokeWidth="1.2"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {mounted && (
        <div
          className="zotero-webai-model-selector-dropdown"
          role="listbox"
          style={{
            ...animStyle,
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            background: theme.modelSelectorBackground,
            border: `1px solid ${theme.modelSelectorBorder}`,
            borderRadius: 10,
            boxShadow: theme.dropdownShadow,
            minWidth: 210,
            maxHeight: 320,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            zIndex: 100,
          }}
        >
          <input
            className="zotero-webai-model-selector-search"
            placeholder={isZh ? "搜索平台..." : "Search platforms..."}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
            style={{
              border: 0,
              borderBottom: `1px solid ${theme.divider}`,
              background: "transparent",
              color: theme.text,
              fontSize: 12,
              outline: 0,
              padding: "8px 10px",
              width: "100%",
            }}
          />
          <div
            className="zotero-webai-model-selector-list"
            style={{
              flex: "1 1 auto",
              overflowY: "auto",
              padding: 4,
              scrollbarWidth: "thin" as const,
            }}
          >
            {groups.map((group) => (
              <div key={group.kind}>
                <div
                  className="zotero-webai-model-selector-group"
                  style={{
                    color: theme.mutedText,
                    fontSize: 10,
                    fontWeight: 600,
                    letterSpacing: 0.4,
                    padding: "6px 8px 2px",
                    textTransform: "uppercase",
                  }}
                >
                  {isZh
                    ? GROUP_LABELS[group.kind].zh
                    : GROUP_LABELS[group.kind].en}
                </div>
                {group.items.map((service) => (
                  <div
                    key={service.id}
                    className="zotero-webai-model-selector-item"
                    role="option"
                    aria-selected={service.id === selected.id}
                    data-selected={
                      service.id === selected.id ? "true" : undefined
                    }
                    onClick={() => handleSelect(service)}
                    style={{
                      padding: "6px 8px",
                      borderRadius: 6,
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      fontSize: 12,
                      transition: TRANSITION.fast,
                      background:
                        service.id === selected.id
                          ? theme.selectionHighlight
                          : "transparent",
                      fontWeight: service.id === selected.id ? 600 : 400,
                      color: theme.text,
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        flexShrink: 0,
                        background: dotColor(service),
                        animation:
                          service.kind === "chat" &&
                          signedIn[service.id] === false
                            ? ANIMATION.pulse
                            : undefined,
                      }}
                    />
                    {service.label}
                  </div>
                ))}
              </div>
            ))}
            {groups.length === 0 && (
              <div
                style={{
                  padding: "12px 8px",
                  fontSize: 12,
                  color: theme.mutedText,
                  textAlign: "center",
                }}
              >
                {isZh ? "未找到匹配平台" : "No matching platforms"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
