import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Resolve from each package as upstream does, while keeping unrelated ancestor
// Yarn PnP manifests out of esbuild's working-directory lookup.
const buildPackage = `
  import { build } from "tsup";
  import { tmpdir } from "node:os";
  import { resolve } from "node:path";
  await build({
    clean: true,
    esbuildOptions(options) {
      options.entryPoints = options.entryPoints.map(entry => resolve(entry));
      if (options.outdir) options.outdir = resolve(options.outdir);
      if (options.outfile) options.outfile = resolve(options.outfile);
      if (options.tsconfig) options.tsconfig = resolve(options.tsconfig);
      options.absWorkingDir = tmpdir();
    },
  });
`;

for (const directory of ["packages/@emulators/core", "packages/@emulators/github", "packages/github-emulator"]) {
  console.log(`Building ${directory}`);
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", buildPackage], {
    cwd: fileURLToPath(new URL(`../${directory}/`, import.meta.url)),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
