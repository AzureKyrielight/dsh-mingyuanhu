import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";

await mkdir("lib", { recursive: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: "lib/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  external: ["@deepseek-ai/*", "sm-crypto"],
  sourcemap: true,
});
const client = await build({
  entryPoints: ["src/client.tsx"],
  bundle: true,
  platform: "browser",
  format: "cjs",
  target: "es2022",
  external: ["react", "react/jsx-runtime"],
  write: false,
  legalComments: "inline",
});
await writeFile(
  "lib/client.js",
  `window.__ModuleLoader__.load({id:'dsh-mingyuanhu',factory:function(require){var module={exports:{}};var exports=module.exports;\n${client.outputFiles[0].text}\nreturn module.exports;}});\n`,
);
