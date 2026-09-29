# Zotero WebAI

[English](README.md)

Zotero WebAI 是一个面向 Zotero 9 的阅读侧边栏插件，可以在当前文献、PDF 阅读器旁边内嵌 DeepSeek Web、Z.ai Web 和 ChatGPT Web。插件不需要模型 API Key，用户直接在内嵌网页中登录，并通过 Zotero 侧边栏把文献上下文、输入框 slash 命令、自定义 Skill 和 MCP 工具真实结果送入网页对话。

## 功能

- 在 Zotero 标签页工具栏（同步按钮左侧）显示 Zotero WebAI 小按钮，点击后打开右侧自适应侧边栏。
- 支持文献库和 PDF 阅读器上下文，带入当前条目、选中文本、导入 PDF 或集合信息。
- 内嵌 DeepSeek Web、Z.ai Web 与 ChatGPT Web 登录页面，并保留外部浏览器打开入口。
- 对话框支持类似 coding 客户端的 slash 命令。
- `/pdf` 将当前 PDF 或 Zotero 条目的全文附加到本次提示词。
- `/websearch` 启动内置联网搜索，并把可读搜索结果附加到本次提示词。
- `/zotero-mcp` 加载本地 `zotero-mcp` 工具目录，让网页模型决定工具名和参数，再由插件本地执行真实 `tools/call`，并把结果插回网页对话。
- 设置页支持新增自定义 Skill，在对话框输入 `/` 即可选择。
- 最多可以添加 1000 个自定义 Skill。
- Results 面板显示 MCP 输出、Skill 提示与结果、PDF 辅助回答、联网搜索回答和网页回答捕获内容。
- 不包含 DeepSeek/Z.ai/ChatGPT API 配置。

## 使用

1. 从 GitHub Releases 下载 `.xpi`。
2. 在 Zotero 9 中打开 `Tools -> Add-ons -> Install Add-on From File...` 安装。
3. 如需 `/zotero-mcp` 工具，请先在本机启动 `zotero-mcp`。
4. 打开 PDF 或选择一条文献。
5. 点击标签页工具栏中（同步按钮左侧）的 Zotero WebAI 按钮。
6. 在侧边栏中登录 DeepSeek Web、Z.ai Web 或 ChatGPT Web。
7. 在对话框输入 `/`，选择 `/pdf`、`/websearch`、`/zotero-mcp` 或自定义 Skill。
8. 发送问题后，插件会尝试自动提交网页对话、捕获网页回答，并在 Results 面板记录本次命令结果。

## Slash 命令

- `/pdf`：显式附加当前 PDF 或条目全文。普通对话不会自动塞入整篇全文，避免上下文被反复占用。
- `/websearch`：显式调用内置联网搜索。工具栏 Web Search 开关和明显的搜索类表达仍可作为便捷触发。
- `/zotero-mcp`：显式从配置的 MCP 端点读取 `tools/list`。网页模型可以输出 `ZOTERO_WEBAI_MCP_REQUEST` 请求块，Zotero WebAI 会在本地执行对应 `tools/call`，并把真实结果插回同一网页对话。
- 自定义 Skill：在设置中最多新增 1000 个 Skill，并通过 `/` 调出使用。

## MCP

Zotero WebAI 默认适配 `zotero-mcp` 的本地 Streamable HTTP 服务。

MCP 不会注入到每一次普通对话中。需要 Zotero MCP 工具时，在输入框选择 `/zotero-mcp`。插件会把 `tools/list` 返回的工具名称、说明和 input schema 放入本次提示词，让网页模型决定是否需要调用工具以及具体参数；插件检测到模型输出的 MCP 请求块后，会调用本地 MCP 服务器的 `tools/call`，把规范化结果显示在 Results 面板，并把结果插回网页对话，让模型继续回答。

在 `/zotero-mcp` 对话中，`tools/list` 返回的所有工具都可由网页模型按需选择。

默认 MCP 配置：

```json
{
  "mcpServers": {
    "zotero-mcp": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:23120/mcp",
      "headers": {
        "Content-Type": "application/json"
      }
    }
  }
}
```

默认工具参数模板：

```json
{"q":"{{query}}","limit":1000,"mode":"complete","relevanceScoring":true,"sort":"relevance"}
```

## 构建

```bash
npm install
npm run build
```

生成的 XPI 位于 `.scaffold/build/`。

构建产物不会提交到源码仓库，发布版 `.xpi` 单独放在 GitHub Releases。


## 支持开发

开发不易，也需要花费时间和 token。如果 Zotero WebAI 对你有帮助，欢迎请我喝一杯咖啡。

<img src="docs/reward-code.png" alt="赞赏码" width="260" />
