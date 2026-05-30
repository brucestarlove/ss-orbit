#!/usr/bin/env node
// Two-edition static build. Bundles public/js/main.js and public/styles.css
// with esbuild, copies HTML/images alongside, and rewrites asset tags to point
// at hashed bundles. Edition is selected via `--edition=full|preview`; preview
// substitutes `__ORBIT_EDITION__` so config.js reports edition="preview".

import { build } from "esbuild";
import { bundleCss } from "./src/core/css-bundle.js";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..");
const PUBLIC_DIR = join(ROOT, "public");
const DIST_DIR = join(ROOT, "dist");

function parseArgs(argv) {
  const args = { edition: "full" };
  for (const a of argv.slice(2)) {
    if (a.startsWith("--edition=")) args.edition = a.slice("--edition=".length);
  }
  if (!["full", "preview", "site"].includes(args.edition)) {
    throw new Error(`--edition must be "full", "preview", or "site" (got "${args.edition}")`);
  }
  return args;
}

// "site" output combines the marketing landing at / with the preview app
// at /app/ — the layout Vercel deploys for orbit.starscape.app.
function assembleSite() {
  const previewDir = join(DIST_DIR, "preview");
  const siteDir = join(DIST_DIR, "site");
  if (!existsSync(previewDir)) {
    throw new Error("dist/preview missing — run `npm run build:preview` first");
  }
  rmSync(siteDir, { recursive: true, force: true });
  mkdirSync(siteDir, { recursive: true });

  // Marketing assets live at the repo root (the landing page references
  // public/orbits-logo.png etc., which we mirror under public/ at the site
  // root so existing href values keep resolving).
  const marketingHtml = readFileSync(join(ROOT, "index.html"), "utf8")
    .replace(/href="public\/index\.html"/g, 'href="/app/"');
  writeFileSync(join(siteDir, "index.html"), marketingHtml);
  writeFileSync(join(siteDir, "install.html"), marketingHtml);
  writeFileSync(join(siteDir, "support.html"), marketingHtml);

  for (const file of ["apple-touch-icon.png", "favicon-32x32.png", "orbits-favicon.png"]) {
    const src = join(ROOT, file);
    if (existsSync(src)) cpSync(src, join(siteDir, file));
  }
  const faviconSrc = join(ROOT, "favicon-32x32.png");
  if (existsSync(faviconSrc)) cpSync(faviconSrc, join(siteDir, "favicon.ico"));

  // Marketing references public/orbits-logo.png etc. — mirror the public/
  // image set at the site root so we don't have to rewrite every img src.
  mkdirSync(join(siteDir, "public"), { recursive: true });
  for (const entry of readdirSync(join(ROOT, "public"))) {
    if (!entry.endsWith(".png")) continue;
    cpSync(join(ROOT, "public", entry), join(siteDir, "public", entry));
  }
  const cursorsSrc = join(ROOT, "public", "cursors");
  if (existsSync(cursorsSrc)) {
    cpSync(cursorsSrc, join(siteDir, "public", "cursors"), { recursive: true });
  }

  // Preview app at /app/.
  cpSync(previewDir, join(siteDir, "app"), { recursive: true });
  const appIndexPath = join(siteDir, "app", "index.html");
  let appHtml = readFileSync(appIndexPath, "utf8");
  appHtml = appHtml
    .replace(/href="(?:\.\/|\/)(apple-touch-icon\.png|favicon-32x32\.png)"/g, 'href="/app/$1"')
    .replace(/href="(styles\.[^"]+\.css)"/g, 'href="/app/$1"')
    .replace(/src="(?:\.\/|\/)([^"]+\.png)"/g, 'src="/app/$1"')
    .replace(/src="(js\/app\.[^"]+\.js)"/g, 'src="/app/$1"');
  writeFileSync(appIndexPath, appHtml);

  console.log(`✓ site → ${siteDir}`);
  console.log(`  /         marketing landing`);
  console.log(`  /app/     preview kanban (IndexedDB)`);
  return;
}

function hashContent(buffer) {
  return createHash("sha256").update(buffer).digest("hex").slice(0, 8);
}

// Preview build replaces api.js's transport import with the IndexedDB
// backend. Filter matches the literal `./transport.js` import string only —
// other imports keep their normal resolution.
function previewTransportPlugin() {
  return {
    name: "preview-transport",
    setup(build) {
      build.onResolve({ filter: /^\.\/transport\.js$/ }, (args) => ({
        path: resolve(args.resolveDir, "local-backend.js")
      }));
    }
  };
}

async function run() {
  const { edition } = parseArgs(process.argv);
  if (edition === "site") {
    return assembleSite();
  }
  const outDir = join(DIST_DIR, edition);

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 1. Bundle JS. Single entry → single file, ESM, minified, tree-shaken.
  const bundleResult = await build({
    entryPoints: [join(PUBLIC_DIR, "js", "main.js")],
    bundle: true,
    format: "esm",
    target: "es2022",
    minify: true,
    sourcemap: true,
    write: false,
    outfile: "app.js",
    define: {
      __ORBIT_EDITION__: JSON.stringify(edition)
    },
    legalComments: "none",
    plugins: edition === "preview" ? [previewTransportPlugin()] : []
  });

  const jsFile = bundleResult.outputFiles.find((f) => f.path.endsWith(".js") && !f.path.endsWith(".map"));
  const mapFile = bundleResult.outputFiles.find((f) => f.path.endsWith(".map"));
  const jsHash = hashContent(jsFile.contents);
  const jsName = `app.${jsHash}.js`;
  mkdirSync(join(outDir, "js"), { recursive: true });
  writeFileSync(join(outDir, "js", jsName), jsFile.contents);
  if (mapFile) writeFileSync(join(outDir, "js", `${jsName}.map`), mapFile.contents);

  // 2. Bundle CSS package imports, then hash + copy the flattened output.
  const cssSrc = join(PUBLIC_DIR, "styles.css");
  const cssBundle = await bundleCss({
    entryPoint: cssSrc,
    outfile: join(outDir, "styles.css"),
    minify: true
  });
  const cssBuf = cssBundle.cssFile.contents;
  const cssHash = hashContent(cssBuf);
  const cssName = `styles.${cssHash}.css`;
  writeFileSync(join(outDir, cssName), cssBuf);

  // 3. Copy static assets (images, favicons) — anything in public/ that
  // isn't HTML/CSS/JS source. Hashing not necessary; long-cache via headers.
  for (const entry of readdirSync(PUBLIC_DIR)) {
    const src = join(PUBLIC_DIR, entry);
    if (entry === "js" || entry === "styles.css") continue;
    if (entry.endsWith(".html")) continue;
    if (statSync(src).isDirectory()) {
      cpSync(src, join(outDir, entry), { recursive: true });
    } else {
      cpSync(src, join(outDir, entry));
    }
  }

  // 4. Render index.html with rewritten asset references.
  const htmlSrc = join(PUBLIC_DIR, "index.html");
  if (!existsSync(htmlSrc)) {
    throw new Error(`Missing ${htmlSrc}`);
  }
  let html = readFileSync(htmlSrc, "utf8");
  // Use relative paths so the bundle works whether the build is mounted at
  // "/" or "/app/" (preview on Vercel).
  html = html.replace(/"\/?js\/main\.js"/g, `"js/${jsName}"`);
  html = html.replace(/"\/?styles\.css"/g, `"${cssName}"`);
  writeFileSync(join(outDir, "index.html"), html);

  // 5. version.json — consumed by support/debug, also lets a status check
  // confirm which bundle a host is serving.
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  writeFileSync(
    join(outDir, "version.json"),
    JSON.stringify(
      {
        name: pkg.name,
        version: pkg.version,
        edition,
        builtAt: new Date().toISOString()
      },
      null,
      2
    ) + "\n"
  );

  const ext = extname(jsName);
  console.log(`✓ ${edition} build → ${outDir}`);
  console.log(`  js:  js/${jsName} (${(jsFile.contents.length / 1024).toFixed(1)} KB${ext === ".js" ? " min" : ""})`);
  console.log(`  css: ${cssName} (${(cssBuf.length / 1024).toFixed(1)} KB)`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
