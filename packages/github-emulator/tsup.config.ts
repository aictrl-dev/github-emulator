import { defineConfig } from "tsup";
import { cpSync } from "node:fs";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: { resolve: true },
  external: [/^node:/],
  sourcemap: true,
  noExternal: [/^@emulators\//],
  onSuccess: async () => {
    cpSync("../@emulators/core/src/fonts", "dist/fonts", { recursive: true });
  },
});
