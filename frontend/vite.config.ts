/// <reference types="vitest" />
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Subresource Integrity (SRI) plugin.
 *
 * Adds integrity="sha384-..." crossorigin="anonymous" attributes to every
 * <script src="..."> and <link rel="stylesheet" href="..."> tag in the built
 * index.html that points at a same-origin asset emitted by Vite.
 *
 * Why we wrote this inline instead of pulling in vite-plugin-sri: a single
 * function in the config beats another supply-chain dependency, and the
 * behavior we want is small and self-contained. Phase 8 step B in ROADMAP.md.
 *
 * Limitations: only same-origin assets bundled by Vite get hashes. Anything
 * loaded dynamically at runtime (or from a CDN) is not covered. The terminal
 * renderer's font/icon assets are bundled, so they are covered.
 */
function sriPlugin(): Plugin {
  return {
    name: "spaiglass-sri",
    apply: "build",
    enforce: "post",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return html;

        // Build a lookup of fileName → sha384 base64 digest for every emitted asset.
        const integrities = new Map<string, string>();
        for (const [fileName, chunk] of Object.entries(bundle)) {
          let source: Buffer | null = null;
          if (chunk.type === "chunk") {
            source = Buffer.from(chunk.code, "utf-8");
          } else if (chunk.type === "asset") {
            source = Buffer.isBuffer(chunk.source)
              ? chunk.source
              : Buffer.from(chunk.source as string | Uint8Array);
          }
          if (!source) continue;
          const hash = createHash("sha384").update(source).digest("base64");
          integrities.set(fileName, `sha384-${hash}`);
        }

        // Inject integrity + crossorigin into matching script and link tags.
        // We rewrite the raw HTML rather than walking the AST because Vite has
        // already finished parsing/transforming and the HTML at this stage is
        // small and well-formed.
        const tagPattern = /<(script|link)([^>]*?)>/g;
        return html.replace(tagPattern, (full, tag: string, attrs: string) => {
          // Find the src or href value
          const urlMatch = attrs.match(/(?:src|href)=["']([^"']+)["']/);
          if (!urlMatch) return full;
          const url = urlMatch[1];

          // Only same-origin paths emitted by the build qualify. Strip leading
          // slash so we can match against the bundle key.
          if (/^https?:\/\//i.test(url)) return full;
          const key = url.replace(/^\/+/, "");
          const integrity = integrities.get(key);
          if (!integrity) return full;

          // Don't double-inject if a previous plugin already added integrity.
          if (/\sintegrity=/.test(attrs)) return full;

          // Vite's react plugin already adds `crossorigin` on emitted asset
          // tags. Only append it ourselves if it's missing.
          const needsCrossorigin = !/\scrossorigin(=|\s|>|$)/.test(attrs);
          const newAttrs = needsCrossorigin
            ? `${attrs} integrity="${integrity}" crossorigin="anonymous"`
            : `${attrs} integrity="${integrity}"`;
          return `<${tag}${newAttrs}>`;
        });
      },
    },
  };
}

// Spaiglass build version: date-based (YYYY.MM.DD). Embedded into the bundle
// at build time so the relay can detect VMs running an out-of-date frontend.
// Override with SPAIGLASS_VERSION env var for reproducible/release builds.
function spaiglassVersion(): string {
  if (process.env.SPAIGLASS_VERSION) return process.env.SPAIGLASS_VERSION;
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}.${mm}.${dd}`;
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(__dirname, ".."), "");
  const apiPort = env.PORT || "8080";
  const version = spaiglassVersion();

  return {
    plugins: [react(), tailwindcss(), sriPlugin()],
    define: {
      __SPAIGLASS_VERSION__: JSON.stringify(version),
    },
    resolve: {
      alias: {
        "@shared": resolve(__dirname, "../shared"),
      },
    },
    server: {
      port: 3000,
      proxy: {
        "/api": {
          target: `http://localhost:${apiPort}`,
          changeOrigin: true,
          secure: false,
        },
      },
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test-setup.ts"],
      globals: true,
      exclude: [
        "**/node_modules/**",
        "**/dist/**",
        "**/cypress/**",
        "**/.{idea,git,cache,output,temp}/**",
        "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build}.config.*",
        "**/scripts/**", // Exclude Playwright demo recording files
        "**/tests/**", // Exclude Playwright validation tests
      ],
    },
  };
});
