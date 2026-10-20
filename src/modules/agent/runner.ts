// One chat turn = one run of the user's own CLI. The conversation carries on
// across turns through the CLI's session (claude --resume, codex exec resume),
// so nothing long-lived has to be kept alive, and a crash costs one turn.
//
// The safety boundary is the command line, checked again on the CLI's own
// account of what it got (the init line): no shell, no file tools, no MCP
// servers but Paperly's, no settings or hooks from the user's own setup.

import { Subprocess, childEnvironment } from "./cli";
import type { SubprocessHandle, SubprocessPipe } from "./cli";
import { createClaudeMapper, createCodexMapper, createLineSplitter } from "./streamParser";
import type { AgentEvent } from "./streamParser";
import type { EngineId } from "./types";
import { agentDirectory, errorMessage, randomHex } from "./util";

export interface TurnRequest {
  engine: EngineId;
  cliPath: string;
  prompt: string;
  systemPrompt: string;
  /** Resume this session; otherwise start one (claude: with `newSessionId`). */
  sessionId?: string;
  newSessionId?: string;
  model?: string;
  effort?: string;
  webSearch: boolean;
  mcp: { url: string; token: string; turnId: string };
  onEvent: (event: AgentEvent) => void;
}

export interface TurnOutcome {
  exitCode: number | null;
  stderr: string;
  stopped: boolean;
  aborted: boolean;
  /** The CLI's final line arrived (a `result`, or codex's turn end). */
  finished: boolean;
}

export interface RunningTurn {
  stop(): void;
  outcome: Promise<TurnOutcome>;
}

const STDERR_LIMIT = 16 * 1024;
/** Paperly's MCP server is the only one; WebSearch is the only built-in. */
const PAPERLY_TOOL_PREFIX = "mcp__paperly__";

export function isAllowedTool(name: string, webSearch: boolean): boolean {
  return name.startsWith(PAPERLY_TOOL_PREFIX) || (webSearch && name === "WebSearch");
}

function tomlString(value: string): string {
  // JSON strings are valid TOML basic strings for everything a prompt holds.
  return JSON.stringify(value);
}

/** Codex features that act on the computer, the browser or the network. */
const CODEX_FEATURES_OFF = [
  "shell_tool",
  "unified_exec",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "image_generation",
  "apps",
  "plugins",
  "multi_agent",
  "hooks",
  "memories",
];

async function writeMcpConfig(request: TurnRequest): Promise<string> {
  const directory = agentDirectory("run");
  await IOUtils.makeDirectory(directory, { createAncestors: true, ignoreExisting: true });
  const path = PathUtils.join(directory, `${request.mcp.turnId.slice(0, 16)}-${randomHex(4)}.json`);
  const config = {
    mcpServers: {
      paperly: {
        type: "http",
        url: request.mcp.url,
        headers: { "X-Paperly-Token": request.mcp.token, "X-Paperly-Turn": request.mcp.turnId },
        // A tool waiting on the user's Allow must not be cut off at the
        // default per-request limit (60 s) or the 5-minute idle limit.
        timeout: 600000,
      },
    },
  };
  // Holds the token: readable by this user only, removed after the turn.
  await IOUtils.writeUTF8(path, JSON.stringify(config));
  await IOUtils.setPermissions(path, 0o600);
  return path;
}

function claudeArguments(request: TurnRequest, mcpConfigPath: string): string[] {
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    // Built-in tools: none but web search. No shell, no file tools.
    "--tools", request.webSearch ? "WebSearch" : "",
    "--strict-mcp-config",
    "--mcp-config", mcpConfigPath,
    "--allowedTools", request.webSearch ? `${PAPERLY_TOOL_PREFIX}*,WebSearch` : `${PAPERLY_TOOL_PREFIX}*`,
    // Anything not allowed above is refused without a prompt nobody could answer.
    "--permission-mode", "dontAsk",
    // The work folder is empty, so this loads no hooks, settings or CLAUDE.md.
    "--setting-sources", "project",
    "--system-prompt", request.systemPrompt,
  ];
  if (request.model) {
    args.push("--model", request.model);
  }
  if (request.effort) {
    args.push("--effort", request.effort);
  }
  if (request.sessionId) {
    args.push("--resume", request.sessionId);
  } else if (request.newSessionId) {
    args.push("--session-id", request.newSessionId);
  }
  return args;
}

function codexArguments(request: TurnRequest, workDirectory: string): string[] {
  const args = ["exec"];
  const options = [
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "-C", workDirectory,
    "--sandbox", "read-only",
    ...CODEX_FEATURES_OFF.flatMap((feature) => ["-c", `features.${feature}=false`]),
    "-c", `mcp_servers.paperly.url=${tomlString(request.mcp.url)}`,
    "-c", 'mcp_servers.paperly.env_http_headers={"X-Paperly-Token"="PAPERLY_MCP_TOKEN","X-Paperly-Turn"="PAPERLY_MCP_TURN"}',
    "-c", "mcp_servers.paperly.tool_timeout_sec=600",
    "-c", 'mcp_servers.paperly.default_tools_approval_mode="auto"',
    "-c", `web_search=${request.webSearch ? '"live"' : '"disabled"'}`,
    "-c", `developer_instructions=${tomlString(request.systemPrompt)}`,
  ];
  if (request.model) {
    options.push("-m", request.model);
  }
  if (request.effort) {
    options.push("-c", `model_reasoning_effort=${tomlString(request.effort)}`);
  }
  if (request.sessionId) {
    // `codex exec resume <id> -`: the options belong to exec, before it.
    return [...args, ...options, "resume", request.sessionId, "-"];
  }
  return [...args, ...options, "-"];
}

/** Starts a turn. Events arrive through `onEvent`; `outcome` settles at exit. */
export async function startTurn(request: TurnRequest): Promise<RunningTurn> {
  const workDirectory = agentDirectory("work");
  await IOUtils.makeDirectory(workDirectory, { createAncestors: true, ignoreExisting: true });

  let mcpConfigPath: string | null = null;
  let args: string[];
  let environment: Record<string, string>;
  let stdinText: string;
  if (request.engine === "claude") {
    mcpConfigPath = await writeMcpConfig(request);
    args = claudeArguments(request, mcpConfigPath);
    environment = childEnvironment(request.cliPath);
    stdinText = `${JSON.stringify({ type: "user", message: { role: "user", content: request.prompt } })}\n`;
  } else {
    args = codexArguments(request, workDirectory);
    environment = childEnvironment(request.cliPath, {
      PAPERLY_MCP_TOKEN: request.mcp.token,
      PAPERLY_MCP_TURN: request.mcp.turnId,
    });
    stdinText = request.prompt;
  }

  const removeConfig = async () => {
    if (mcpConfigPath) {
      const path = mcpConfigPath;
      mcpConfigPath = null;
      await IOUtils.remove(path, { ignoreAbsent: true }).catch(() => undefined);
    }
  };

  let proc: SubprocessHandle;
  try {
    proc = await Subprocess().call({
      command: request.cliPath,
      arguments: args,
      environment,
      workdir: workDirectory,
      stderr: "pipe",
    });
  } catch (error) {
    await removeConfig();
    throw new Error(`Could not start ${request.cliPath}: ${errorMessage(error)}`);
  }

  let stopped = false;
  let aborted = false;
  let finished = false;
  let stderr = "";

  const stop = () => {
    if (stopped) {
      return;
    }
    stopped = true;
    void proc.kill(500).catch(() => undefined);
  };

  const mapperOptions = { isToolAllowed: (name: string) => isAllowedTool(name, request.webSearch) };
  const emit = (event: AgentEvent) => {
    if (event.type === "done") {
      finished = true;
    }
    try {
      request.onEvent(event);
    } catch (error) {
      Zotero.logError(error as Error);
    }
  };
  const mapper =
    request.engine === "claude"
      ? createClaudeMapper(emit, mapperOptions)
      : createCodexMapper(emit, mapperOptions);
  const splitter = createLineSplitter((line) => {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return; // codex prints a few non-JSON notices; claude never should
    }
    if (mapper(message) === "abort") {
      aborted = true;
      stop();
    }
  });

  const drainStderr = async (pipe: SubprocessPipe | null) => {
    if (!pipe) {
      return;
    }
    try {
      let chunk: string;
      while ((chunk = await pipe.readString())) {
        if (stderr.length < STDERR_LIMIT) {
          stderr += chunk;
        }
      }
    } catch {
      // closed by a kill
    }
  };

  const outcome = (async (): Promise<TurnOutcome> => {
    const stderrDone = drainStderr(proc.stderr);
    try {
      await proc.stdin.write(stdinText);
    } catch {
      // A CLI that failed at once has closed its stdin; its exit says why.
    }
    await proc.stdin.close().catch(() => undefined);
    try {
      let chunk: string;
      while ((chunk = await proc.stdout.readString())) {
        splitter.push(chunk);
      }
    } catch {
      // closed by a kill
    }
    splitter.flush();
    await stderrDone;
    let exitCode: number | null = null;
    try {
      exitCode = (await proc.wait()).exitCode;
    } catch {
      exitCode = null;
    }
    await removeConfig();
    return { exitCode, stderr: stderr.trim(), stopped, aborted, finished };
  })();

  return { stop, outcome };
}
