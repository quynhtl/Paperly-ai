// Signing a CLI in from Paperly, through its maker's own sign-in page.
//
// Claude: the unmodified `claude auth login` runs with pipes. It prints the
// link to Anthropic's page; the user signs in there in their browser, the
// page shows a code, the user pastes it into Paperly, and Paperly hands it to
// the CLI on stdin. Codex: `codex login --device-auth` prints OpenAI's device
// page and a code the user types there. Either way the credential is stored
// by the CLI itself; Paperly never sees it. The CLI's own status command
// decides whether it worked.

import { Subprocess, childEnvironment, forgetCliStatus, getCliStatus } from "./cli";
import type { SubprocessHandle, SubprocessPipe } from "./cli";
import { claudeSignInCode, claudeSignInPrompt, codexDevicePrompt } from "./signInText";
import type { EngineId } from "./types";
import { agentDirectory, errorMessage, later } from "./util";

export interface SignInState {
  engine: EngineId;
  phase: "starting" | "waiting" | "checking" | "succeeded" | "failed" | "cancelled";
  /** The maker's sign-in page. */
  url?: string;
  /** Codex: the code to type on OpenAI's page. */
  userCode?: string;
  /** Claude: whether the code from Anthropic's page has been passed on. */
  codeSent?: boolean;
  message?: string;
}

export interface SignInFlow {
  state(): SignInState;
  submitCode(code: string): boolean;
  cancel(): void;
}

const OUTPUT_LIMIT = 32 * 1024;
const FLOW_TIMEOUT_MS = 10 * 60_000;
const STARTUP_TIMEOUT_MS = 30_000;

export async function startSignIn(
  engine: EngineId,
  cliPath: string,
  onChange: (state: SignInState) => void,
): Promise<SignInFlow> {
  let state: SignInState = { engine, phase: "starting" };
  const update = (next: Partial<SignInState>) => {
    state = { ...state, ...next };
    onChange(state);
  };

  const workDirectory = agentDirectory("work");
  await IOUtils.makeDirectory(workDirectory, { createAncestors: true, ignoreExisting: true });
  const args = engine === "claude" ? ["auth", "login"] : ["login", "--device-auth"];
  // BROWSER=true: the CLI "opens" the page with a command that does nothing
  // and prints the link instead; Paperly opens it, so it opens once.
  const environment = childEnvironment(cliPath, Zotero.isWin ? {} : { BROWSER: "true" });

  let proc: SubprocessHandle;
  try {
    proc = await Subprocess().call({
      command: cliPath,
      arguments: args,
      environment,
      workdir: workDirectory,
      stderr: "pipe",
    });
  } catch (error) {
    update({ phase: "failed", message: `Could not start sign-in: ${errorMessage(error)}` });
    return { state: () => state, submitCode: () => false, cancel: () => undefined };
  }

  let output = "";
  let finished = false;
  const finish = (next: Partial<SignInState>) => {
    if (finished) {
      return;
    }
    finished = true;
    cancelTimeout();
    cancelStartup();
    update(next);
  };
  const cancelTimeout = later(() => {
    finish({ phase: "failed", message: "Sign-in took too long. Start it again." });
    void proc.kill(300).catch(() => undefined);
  }, FLOW_TIMEOUT_MS);
  const cancelStartup = later(() => {
    if (state.phase === "starting") {
      finish({ phase: "failed", message: "The sign-in page did not come up. Update the CLI, or sign in from Terminal." });
      void proc.kill(300).catch(() => undefined);
    }
  }, STARTUP_TIMEOUT_MS);

  const receive = (chunk: string) => {
    if (finished || output.length > OUTPUT_LIMIT) {
      return;
    }
    output += chunk;
    if (state.phase !== "starting") {
      return;
    }
    if (engine === "claude") {
      const url = claudeSignInPrompt(output);
      if (url) {
        cancelStartup();
        update({ phase: "waiting", url });
        Zotero.launchURL(url);
      }
    } else {
      const prompt = codexDevicePrompt(output);
      if (prompt) {
        cancelStartup();
        update({ phase: "waiting", url: prompt.url, userCode: prompt.userCode });
        Zotero.launchURL(prompt.url);
      }
    }
  };
  const drain = async (pipe: SubprocessPipe | null) => {
    if (!pipe) {
      return;
    }
    try {
      let chunk: string;
      while ((chunk = await pipe.readString())) {
        receive(chunk);
      }
    } catch {
      // closed
    }
  };

  void (async () => {
    await Promise.all([drain(proc.stdout), drain(proc.stderr)]);
    let exitCode: number | null = null;
    try {
      exitCode = (await proc.wait()).exitCode;
    } catch {
      exitCode = null;
    }
    if (finished) {
      return;
    }
    update({ phase: "checking" });
    forgetCliStatus(engine);
    const status = await getCliStatus(engine, true);
    if (status.signedIn) {
      finish({ phase: "succeeded" });
      return;
    }
    const said = output.replace(/\s+/g, " ").trim();
    finish({
      phase: "failed",
      message:
        state.codeSent && /invalid|expired|denied|rejected/i.test(said)
          ? "That code was not accepted. Start again and paste the whole code the page shows."
          : exitCode === 0
            ? "The sign-in finished, but the CLI is still not signed in. Try again."
            : `The sign-in stopped${said ? `: ${said.slice(-200)}` : "."}`,
    });
  })();

  return {
    state: () => state,
    submitCode(code: string) {
      if (engine !== "claude" || finished || state.phase !== "waiting") {
        return false;
      }
      const clean = claudeSignInCode(code);
      if (!clean) {
        return false;
      }
      update({ codeSent: true });
      void proc.stdin.write(`${clean}\n`).catch(() => undefined);
      return true;
    },
    cancel() {
      if (finished) {
        return;
      }
      finish({ phase: "cancelled" });
      void proc.kill(300).catch(() => undefined);
    },
  };
}
