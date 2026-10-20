// Sign-in prompts, as the CLIs print them (samples as recorded by
// OpenMausBot's tests against claude and codex), and look-alikes that must
// not be shown.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeSignInCode,
  claudeSignInLink,
  claudeSignInPrompt,
  codexDevicePrompt,
  stripTerminalCodes,
} from "../../src/modules/agent/signInText.ts";

test("claude: the link, only once its line is complete", () => {
  const partial = "Opening browser…\nIf the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true";
  assert.equal(claudeSignInPrompt(partial), null);
  assert.equal(
    claudeSignInPrompt(`${partial}&state=abc\nPaste code here if prompted > `),
    "https://claude.com/cai/oauth/authorize?code=true&state=abc",
  );
});

test("claude: only https links on Anthropic's own hosts", () => {
  assert.ok(claudeSignInLink("https://claude.com/cai/oauth/authorize?code=true"));
  assert.ok(claudeSignInLink("https://platform.claude.com/oauth/code/callback"));
  assert.ok(claudeSignInLink("https://console.anthropic.com/oauth/authorize"));
  for (const bad of [
    "http://claude.com/x",
    "https://evil.example/claude.com",
    "https://claude.com.evil.example/x",
    "https://user:pw@claude.com/x",
    "javascript:alert(1)",
  ]) {
    assert.equal(claudeSignInLink(bad), null, bad);
  }
  assert.equal(claudeSignInPrompt("visit: https://evil.example/x\n"), null);
});

test("claude: the pasted code", () => {
  assert.equal(claudeSignInCode("  abcDEF123_-#state.9:x  "), "abcDEF123_-#state.9:x");
  assert.equal(claudeSignInCode("short"), null);
  assert.equal(claudeSignInCode("has spaces in it"), null);
});

test("codex: device page and code, colours stripped", () => {
  const prompt = "  \u001b[36mhttps://auth.openai.com/codex/device\u001b[0m\n  0CSG-0IXIM\n";
  assert.deepEqual(codexDevicePrompt(prompt), { url: "https://auth.openai.com/codex/device", userCode: "0CSG-0IXIM" });
  assert.equal(codexDevicePrompt(prompt.replace("0IXIM\n", "0IXI")), null, "code line not finished");
  for (const url of [
    "http://auth.openai.com/codex/device",
    "https://evil.example/codex/device",
    "https://auth.openai.com/codex/device?token=secret",
  ]) {
    assert.equal(codexDevicePrompt(`${url}\nABCD-EFGHI\n`), null, url);
  }
  assert.equal(codexDevicePrompt("https://auth.openai.com/codex/device\nsecret-token-value\n"), null);
  assert.equal(stripTerminalCodes("\u001b[1mbold\u001b[0m"), "bold");
});
