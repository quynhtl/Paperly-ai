import React from "react";
import type { SidebarTheme } from "../theme";

export interface TokenUsageBarProps {
  inputTokens: number;
  outputTokens: number;
  contextUsed: number;
  contextMax: number;
  theme: SidebarTheme;
  isZh: boolean;
  visible: boolean;
}

export const TokenUsageBar: React.FC<TokenUsageBarProps> = ({
  inputTokens,
  outputTokens,
  contextUsed,
  contextMax,
  theme,
  isZh,
  visible,
}) => {
  if (!visible) {
    return null;
  }

  const usagePercent =
    contextMax > 0 ? Math.min((contextUsed / contextMax) * 100, 100) : 0;

  const formatCount = (n: number): string => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return String(n);
  };

  return (
    <div
      className="zotero-webai-token-bar"
      style={{
        alignItems: "center",
        display: "flex",
        fontSize: 10,
        gap: 8,
        padding: "4px 12px",
        borderTop: `1px solid ${theme.divider}`,
        color: theme.mutedText,
      }}
    >
      {/* Input token badge */}
      <span
        className="zotero-webai-token-badge"
        style={{
          alignItems: "center",
          background: theme.tokenBadgeBackground,
          border: `1px solid ${theme.tokenBadgeBorder}`,
          borderRadius: 9999,
          color: theme.tokenBadgeText,
          display: "inline-flex",
          fontSize: 10,
          gap: 3,
          lineHeight: 1,
          padding: "2px 6px",
        }}
        title={isZh ? `输入: ${inputTokens} tokens` : `Input: ${inputTokens} tokens`}
      >
        <span style={{ opacity: 0.7 }}>↑</span>
        {formatCount(inputTokens)}
      </span>

      {/* Output token badge */}
      <span
        className="zotero-webai-token-badge"
        style={{
          alignItems: "center",
          background: theme.tokenBadgeBackground,
          border: `1px solid ${theme.tokenBadgeBorder}`,
          borderRadius: 9999,
          color: theme.tokenBadgeText,
          display: "inline-flex",
          fontSize: 10,
          gap: 3,
          lineHeight: 1,
          padding: "2px 6px",
        }}
        title={isZh ? `输出: ${outputTokens} tokens` : `Output: ${outputTokens} tokens`}
      >
        <span style={{ opacity: 0.7 }}>↓</span>
        {formatCount(outputTokens)}
      </span>

      {/* Context progress bar */}
      {contextMax > 0 && (
        <>
          <div
            className="zotero-webai-token-progress"
            style={{
              flex: "1 1 auto",
              height: 3,
              borderRadius: 9999,
              background: theme.tokenProgressTrack,
              overflow: "hidden",
              position: "relative",
            }}
          >
            <div
              className="zotero-webai-token-progress-fill"
              style={{
                height: "100%",
                width: `${usagePercent}%`,
                borderRadius: 9999,
                background: usagePercent > 90
                  ? theme.errorText
                  : usagePercent > 70
                    ? theme.warningText
                    : theme.tokenProgressFill,
                transition: "width 200ms cubic-bezier(0.4, 0, 0.2, 1)",
              }}
            />
          </div>
          <span style={{ whiteSpace: "nowrap" }}>
            {usagePercent.toFixed(0)}%
          </span>
        </>
      )}
    </div>
  );
};
