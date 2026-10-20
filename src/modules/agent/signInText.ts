// Reading the sign-in prompts the CLIs print, so Paperly can show them.
//
// `claude auth login` prints a link to Anthropic's sign-in page and then waits
// for the code that page shows; `codex login --device-auth` prints OpenAI's
// device page and a one-time code. Paperly shows only a link on the maker's
// own https host, and never sees a password or a token.
//
// No runtime imports: the tests load this file straight into Node.

const CLAUDE_SIGN_IN_HOSTS = ["claude.com", "claude.ai", "anthropic.com", "platform.claude.com"];
const CODEX_DEVICE_PAGE = "https://auth.openai.com/codex/device";

export function stripTerminalCodes(text: string): string {
  // eslint-disable-next-line no-control-regex
  return String(text || "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007]*\u0007/g, "");
}

/** A link worth showing: https, on Anthropic's own hosts, with no credentials in it. */
export function claudeSignInLink(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trusted = CLAUDE_SIGN_IN_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    return url.protocol === "https:" && trusted && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** The sign-in link from `claude auth login` output, once its line is complete. */
export function claudeSignInPrompt(output: string): string | null {
  const lines = stripTerminalCodes(output).split(/\r?\n/).slice(0, -1);
  for (const line of lines) {
    const match = /(https:\/\/\S+)/.exec(line.trim());
    const link = match ? claudeSignInLink(match[1].replace(/[),.;]+$/, "")) : null;
    if (link) {
      return link;
    }
  }
  return null;
}

/** What Anthropic's page shows after sign-in: a code, sometimes with `#state`. */
export function claudeSignInCode(value: string): string | null {
  const code = String(value || "").trim();
  return /^[A-Za-z0-9_\-#.:]{8,1024}$/.test(code) ? code : null;
}

/** OpenAI's device page and the code to type there, once both lines are complete. */
export function codexDevicePrompt(output: string): { url: string; userCode: string } | null {
  const lines = stripTerminalCodes(output)
    .split(/\r?\n/)
    .slice(0, -1)
    .map((line) => line.trim());
  if (!lines.some((line) => line === CODEX_DEVICE_PAGE || line === `${CODEX_DEVICE_PAGE}/`)) {
    return null;
  }
  const userCode = lines.find((line) => /^[A-Z0-9]{4,8}-[A-Z0-9]{4,8}$/.test(line));
  return userCode ? { url: CODEX_DEVICE_PAGE, userCode } : null;
}
