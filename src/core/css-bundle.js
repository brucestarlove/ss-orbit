// CSS bundling seam for Starscape UI package imports.
//
// public/styles.css remains Orbit's editable source of truth, but it can now
// import @starlove/ui component CSS. Static builds and source dev serving both
// pass that source through esbuild so browsers never have to resolve package
// specifiers from raw CSS.

const CURSOR_ASSET_LOADERS = {
  ".cur": "file"
};

export async function bundleCss({ entryPoint, outfile, minify = false }) {
  const { build } = await import("esbuild");
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    target: "es2022",
    minify,
    sourcemap: false,
    write: false,
    outfile,
    assetNames: "cursors/[name]",
    loader: CURSOR_ASSET_LOADERS,
    legalComments: "none"
  });
  const cssFile = result.outputFiles.find((file) => file.path.endsWith(".css"));
  if (!cssFile) throw new Error("CSS bundle did not produce a stylesheet");
  return { cssFile, outputFiles: result.outputFiles };
}
