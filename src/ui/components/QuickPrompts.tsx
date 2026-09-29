import React, { useCallback } from "react";
import type { SidebarTheme } from "../theme";
import { TRANSITION } from "../animations";

export interface QuickPromptItem {
  id: string;
  label: string;
  prompt: string;
}

export interface QuickPromptsProps {
  prompts: QuickPromptItem[];
  theme: SidebarTheme;
  isZh: boolean;
  onSelect: (prompt: QuickPromptItem) => void;
}

const DEFAULT_PROMPTS_ZH: QuickPromptItem[] = [
  { id: "summarize", label: "总结", prompt: "请总结这篇论文的核心内容和主要贡献。" },
  { id: "explain", label: "解释", prompt: "请解释选中的内容，用简洁清晰的语言。" },
  { id: "translate", label: "翻译", prompt: "请将以下内容翻译成中文：" },
  { id: "critique", label: "评析", prompt: "请对这篇论文进行批判性分析，指出其优缺点。" },
  { id: "methodology", label: "方法", prompt: "请解释这篇论文使用的研究方法和实验设计。" },
  { id: "keyfindings", label: "发现", prompt: "请列出这篇论文的关键发现和结论。" },
];

const DEFAULT_PROMPTS_EN: QuickPromptItem[] = [
  { id: "summarize", label: "Summarize", prompt: "Please summarize the core content and main contributions of this paper." },
  { id: "explain", label: "Explain", prompt: "Please explain the selected content in clear, concise language." },
  { id: "translate", label: "Translate", prompt: "Please translate the following content:" },
  { id: "critique", label: "Critique", prompt: "Please provide a critical analysis of this paper, noting strengths and weaknesses." },
  { id: "methodology", label: "Methods", prompt: "Please explain the research methods and experimental design used in this paper." },
  { id: "keyfindings", label: "Findings", prompt: "Please list the key findings and conclusions of this paper." },
];

export function getDefaultQuickPrompts(isZh: boolean): QuickPromptItem[] {
  return isZh ? DEFAULT_PROMPTS_ZH : DEFAULT_PROMPTS_EN;
}

export const QuickPrompts: React.FC<QuickPromptsProps> = ({
  prompts,
  theme,
  isZh,
  onSelect,
}) => {
  const handleClick = useCallback(
    (prompt: QuickPromptItem) => {
      onSelect(prompt);
    },
    [onSelect],
  );

  if (prompts.length === 0) {
    return null;
  }

  return (
    <div
      className="zotero-webai-quick-prompts"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 4,
        padding: "4px 8px",
      }}
    >
      {prompts.map((prompt) => (
        <button
          key={prompt.id}
          className="zotero-webai-quick-prompt-pill"
          onClick={() => handleClick(prompt)}
          title={prompt.prompt}
          style={{
            appearance: "none",
            background: theme.quickPromptBackground,
            border: `1px solid ${theme.quickPromptBorder}`,
            borderRadius: 9999,
            color: theme.quickPromptText,
            cursor: "pointer",
            fontSize: 11,
            lineHeight: 1,
            padding: "4px 10px",
            transition: TRANSITION.fast,
            whiteSpace: "nowrap",
          }}
        >
          {prompt.label}
        </button>
      ))}
    </div>
  );
};
