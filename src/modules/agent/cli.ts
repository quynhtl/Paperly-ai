// Finding the user's own agent CLIs (`claude`, `codex`), and running them.
//
// Paperly never signs anyone in itself and never reads a credential: each CLI
// keeps its own login, made through its maker's own sign-in page. Paperly
// only asks the CLI whether it is signed in (`claude auth status --json`,
// `codex login status`), the way OpenMausBot does.

import { config } from "../../../package.json";
import { getPref } from "../../utils/prefs";
import type { EngineId } from "./types";
import { errorMessage, later } from "./util";

export interface SubprocessPipe {
  readString(): Promise<string>;
}

export interface SubprocessHandle {
  stdin: { write(data: string): Promise<unknown>; close(): Promise<unknown> };
  stdout: SubprocessPipe;
  stderr: SubprocessPipe | null;
  wait(): Promise<{ exitCode: number }>;
  kill(timeout?: number): Promise<{ exitCode: number }>;
}

interface SubprocessModule {
  call(options: {
    command: string;
    arguments: string[];
    environment?: Record<string, string>;
    workdir?: string;
    stderr?: "pipe" | "stdout" | "ignore";
  }): Promise<SubprocessHandle>;
  getEnvironment(): Record<string, string>;
  pathSearch(command: string, environment?: Record<string, string>): Promise<string>;
}

let subprocessModule: SubprocessModule | null = null;

export function Subprocess(): SubprocessModule {
  if (!subprocessModule) {
    subprocessModule = (
      ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs") as {
        Subprocess: SubprocessModule;
      }
    ).Subprocess;
  }
  return subprocessModule;
}

export const ENGINE_LABELS: Record<EngineId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const BINARIES: Record<EngineId, string> = { claude: "claude", codex: "codex" };
const PATH_PREFS: Record<EngineId, string> = {
  claude: "agent.claudePath",
  codex: "agent.codexPath",
};

/** The official install commands, shown to the user to run themselves. */
export const INSTALL_COMMANDS: Record<EngineId, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "npm install -g @openai/codex",
};

/** A parent Claude Code session's own variables; a nested CLI must not inherit them. */
const SCRUBBED_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_EMIT_STARTUP_TIMING",
  "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING",
  "CLAUDE_CODE_ENABLE_TASKS",
  "CLAUDE_CODE_QUESTION_PREVIEW_FORMAT",
  "CLAUDE_CODE_SSE_PORT",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
];

function homeDirectory(): string {
  return (
    Services.env.get("HOME") ||
    Services.env.get("USERPROFILE") ||
    Services.dirsvc.get("Home", Components.interfaces.nsIFile).path
  );
}

function pathSeparator(): string {
  return Zotero.isWin ? ";" : ":";
}

/**
 * The environment a CLI runs with. An app opened from the Finder or the Dock
 * gets a short PATH, so the usual install folders are added; `USER` is
 * needed by Claude Code to find its sign-in in the Keychain.
 */
export function childEnvironment(
  cliPath?: string | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const environment: Record<string, string> = { ...Subprocess().getEnvironment() };
  for (const name of SCRUBBED_VARIABLES) {
    delete environment[name];
  }
  const home = homeDirectory();
  if (!environment.HOME && home) {
    environment.HOME = home;
  }
  if (!environment.USER) {
    const user = environment.LOGNAME || PathUtils.filename(home);
    if (user) {
      environment.USER = user;
    }
  }
  if (!environment.LOGNAME && environment.USER) {
    environment.LOGNAME = environment.USER;
  }
  const separator = pathSeparator();
  const folders = [
    cliPath ? PathUtils.parent(cliPath) : null,
    ...String(environment.PATH || "").split(separator),
    PathUtils.join(home, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((folder): folder is string => Boolean(folder));
  environment.PATH = [...new Set(folders)].join(separator);
  environment.NO_COLOR = "1";
  return { ...environment, ...extra };
}

async function exists(path: string): Promise<boolean> {
  try {
    return await IOUtils.exists(path);
  } catch {
    return false;
  }
}

async function nvmCandidates(name: string): Promise<string[]> {
  const root = PathUtils.join(homeDirectory(), ".nvm", "versions", "node");
  try {
    const versions = await IOUtils.getChildren(root);
    return versions.sort().reverse().map((version) => PathUtils.join(version, "bin", name));
  } catch {
    return [];
  }
}

async function candidatePaths(engine: EngineId): Promise<string[]> {
  const name = BINARIES[engine];
  const home = homeDirectory();
  if (Zotero.isWin) {
    const appData = Services.env.get("APPDATA");
    return [
      PathUtils.join(home, ".local", "bin", `${name}.exe`),
      appData ? PathUtils.join(appData, "npm", `${name}.cmd`) : "",
    ].filter(Boolean);
  }
  return [
    PathUtils.join(home, ".local", "bin", name),
    ...(engine === "claude" ? [PathUtils.join(home, ".claude", "local", name)] : []),
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
    PathUtils.join(home, ".npm-global", "bin", name),
    PathUtils.join(home, ".bun", "bin", name),
    PathUtils.join(home, ".volta", "bin", name),
    ...(await nvmCandidates(name)),
    `/usr/bin/${name}`,
  ];
}

/** The pref (Settings) wins; then the usual install folders; then PATH. */
export async function findCliPath(engine: EngineId): Promise<string | null> {
  const configured = String(getPref(PATH_PREFS[engine]) || "").trim();
  if (configured) {
    return (await exists(configured)) ? configured : null;
  }
  for (const candidate of await candidatePaths(engine)) {
    if (await exists(candidate)) {
      return candidate;
    }
  }
  try {
    const found = await Subprocess().pathSearch(BINARIES[engine], childEnvironment());
    return found || null;
  } catch {
    return null;
  }
}

export function configuredPathPref(engine: EngineId): string {
  return `${config.prefsPrefix}.${PATH_PREFS[engine]}`;
}

export interface CaptureResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const CAPTURE_LIMIT = 256 * 1024;

/** Runs a CLI to completion with stdin closed, and collects what it prints. */
export async function runCapture(
  command: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string; environment?: Record<string, string> } = {},
): Promise<CaptureResult> {
  const proc = await Subprocess().call({
    command,
    arguments: args,
    environment: options.environment || childEnvironment(command),
    workdir: options.cwd,
    stderr: "pipe",
  });
  void proc.stdin.close().catch(() => undefined);
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const cancel = later(() => {
    timedOut = true;
    void proc.kill(300).catch(() => undefined);
  }, options.timeoutMs ?? 15000);
  const drain = async (pipe: SubprocessPipe | null, append: (text: string) => void) => {
    if (!pipe) {
      return;
    }
    try {
      let chunk: string;
      while ((chunk = await pipe.readString())) {
        append(chunk);
      }
    } catch {
      // The pipe closes when the process is killed.
    }
  };
  await Promise.all([
    drain(proc.stdout, (text) => {
      if (stdout.length < CAPTURE_LIMIT) stdout += text;
    }),
    drain(proc.stderr, (text) => {
      if (stderr.length < CAPTURE_LIMIT) stderr += text;
    }),
  ]);
  let exitCode: number | null = null;
  try {
    exitCode = (await proc.wait()).exitCode;
  } catch {
    exitCode = null;
  }
  cancel();
  return { exitCode, stdout, stderr, timedOut };
}

export interface CliStatus {
  engine: EngineId;
  path: string | null;
  version: string | null;
  /** null when it could not be told (the check itself failed). */
  signedIn: boolean | null;
  /** How the CLI is signed in: "claude.ai", "api_key", "ChatGPT", "API key"... */
  method?: string;
  plan?: string;
  problem?: string;
  checkedAt: number;
}

const statusCache = new Map<EngineId, CliStatus>();
const pendingChecks = new Map<EngineId, Promise<CliStatus>>();

export function cachedCliStatus(engine: EngineId): CliStatus | null {
  return statusCache.get(engine) || null;
}

async function checkClaude(path: string): Promise<Partial<CliStatus>> {
  const version = await runCapture(path, ["--version"], { timeoutMs: 15000 });
  const versionText = /(\d+\.\d+\.\d+)/.exec(version.stdout)?.[1] || null;
  const auth = await runCapture(path, ["auth", "status", "--json"], { timeoutMs: 15000 });
  try {
    const status = JSON.parse(auth.stdout) as {
      loggedIn?: boolean;
      authMethod?: string;
      subscriptionType?: string;
    };
    return {
      version: versionText,
      signedIn: status.loggedIn === true,
      method: typeof status.authMethod === "string" ? status.authMethod : undefined,
      plan: typeof status.subscriptionType === "string" ? status.subscriptionType : undefined,
    };
  } catch {
    return {
      version: versionText,
      signedIn: null,
      problem: (auth.stderr || auth.stdout).trim().slice(0, 300) || "Claude Code did not say whether it is signed in.",
    };
  }
}

async function checkCodex(path: string): Promise<Partial<CliStatus>> {
  const version = await runCapture(path, ["--version"], { timeoutMs: 15000 });
  const versionText = /(\d+\.\d+\.\d+)/.exec(version.stdout + version.stderr)?.[1] || null;
  const login = await runCapture(path, ["login", "status"], { timeoutMs: 15000 });
  const said = `${login.stdout}\n${login.stderr}`.trim();
  if (login.exitCode === 0 && /logged in/i.test(said) && !/not logged in/i.test(said)) {
    const method = /logged in using (.+)/i.exec(said)?.[1]?.trim();
    return { version: versionText, signedIn: true, method };
  }
  if (/not logged in/i.test(said) || login.exitCode === 1) {
    return { version: versionText, signedIn: false };
  }
  return { version: versionText, signedIn: null, problem: said.slice(0, 300) };
}

/** Is the CLI there, and signed in? Cached; `refresh` asks again. */
export function getCliStatus(engine: EngineId, refresh = false): Promise<CliStatus> {
  const cached = statusCache.get(engine);
  const fresh = cached && Date.now() - cached.checkedAt < (cached.signedIn ? 10 * 60_000 : 20_000);
  if (cached && fresh && !refresh) {
    return Promise.resolve(cached);
  }
  const running = pendingChecks.get(engine);
  if (running) {
    return running;
  }
  const check = (async (): Promise<CliStatus> => {
    const base: CliStatus = { engine, path: null, version: null, signedIn: null, checkedAt: Date.now() };
    try {
      const path = await findCliPath(engine);
      if (!path) {
        return { ...base, signedIn: false };
      }
      const details = engine === "claude" ? await checkClaude(path) : await checkCodex(path);
      return { ...base, path, ...details, checkedAt: Date.now() };
    } catch (error) {
      return { ...base, problem: errorMessage(error) };
    }
  })().then((status) => {
    statusCache.set(engine, status);
    pendingChecks.delete(engine);
    return status;
  });
  pendingChecks.set(engine, check);
  return check;
}

export function forgetCliStatus(engine?: EngineId): void {
  if (engine) {
    statusCache.delete(engine);
  } else {
    statusCache.clear();
  }
}
