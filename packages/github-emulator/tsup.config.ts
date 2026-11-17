import { defineConfig } from "tsup";
import { cpSync, rmSync } from "node:fs";
import { emitTypes } from "../../scripts/emit-types.mjs";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  // tsup's `dts` needs the TypeScript 6 API; declarations come from tsc in onSuccess instead.
  dts: false,
  external: [/^node:/],
  sourcemap: true,
  noExternal: [/^@emulators\//],
  onSuccess: async () => {
    cpSync("../@emulators/core/src/fonts", "dist/fonts", { recursive: true });
    // Declarations from deleted sources must not reach the bundled dist/index.d.ts.
    rmSync(".types", { recursive: true, force: true });
    emitTypes(__dirname, { bundle: true });
  },
});
