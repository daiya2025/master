import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

const watch = process.argv.includes("--watch");

const common = {
  bundle: true,
  sourcemap: true,
  logLevel: "info",
  target: ["es2022"],
};

const configs = [
  {
    ...common,
    entryPoints: ["src/main/main.ts"],
    outfile: "dist/main/main.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  },
  {
    ...common,
    entryPoints: ["src/preload/preload.ts"],
    outfile: "dist/preload/preload.js",
    platform: "node",
    format: "cjs",
    external: ["electron"],
  },
  {
    ...common,
    entryPoints: ["src/renderer/main.ts"],
    outfile: "dist/renderer/renderer.js",
    platform: "browser",
    format: "iife",
    // @replit/codemirror-emacs registers its key and command tables with calls annotated
    // @__PURE__; honouring the annotation would strip them and leave the Emacs layer inert.
    ignoreAnnotations: true,
  },
];

mkdirSync("dist/renderer", { recursive: true });
cpSync("src/renderer/index.html", "dist/renderer/index.html");
cpSync("src/renderer/styles.css", "dist/renderer/styles.css");

if (watch) {
  const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log("watching...");
} else {
  await Promise.all(configs.map((c) => esbuild.build(c)));
}
