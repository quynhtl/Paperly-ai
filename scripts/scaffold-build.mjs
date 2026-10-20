import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Build, Config } from "zotero-plugin-scaffold";

// KaTeX's stylesheet and fonts, for the agent chat's math. Copied from the
// installed package on every build (addon/content/katex is git-ignored), woff2
// only: Gecko takes the first source a @font-face names, and that is woff2.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const katexDist = join(root, "node_modules", "katex", "dist");
const katexOut = join(root, "addon", "content", "katex");
rmSync(katexOut, { recursive: true, force: true });
mkdirSync(join(katexOut, "fonts"), { recursive: true });
cpSync(join(katexDist, "katex.min.css"), join(katexOut, "katex.min.css"));
for (const font of readdirSync(join(katexDist, "fonts"))) {
  if (font.endsWith(".woff2")) {
    cpSync(join(katexDist, "fonts", font), join(katexOut, "fonts", font));
  }
}

const ctx = await Config.loadConfig({});
const builder = new Build(ctx);

await builder.run();
