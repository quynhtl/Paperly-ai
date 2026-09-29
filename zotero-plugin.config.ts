import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";

declare const process: {
  env: Record<string, string | undefined>;
};

const xpiName = `${pkg.config.addonName.replace(/\s+/g, ".")}-${pkg.version}`;

const config: ReturnType<typeof defineConfig> = defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  xpiName,
  updateURL: "https://github.com/{{owner}}/{{repo}}/releases/download/release/update.json",
  xpiDownloadLink:
    "https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi",

  build: {
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildVersionName: pkg.version,
      buildTime: "{{buildTime}}",
    },
    fluent: {
      prefixFluentMessages: false,
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  server: {
    devtools: false,
    startArgs: ["-no-remote"],
    prefs: {},
    asProxy: true,
    createProfileIfMissing: true,
  },
});

export default config;
