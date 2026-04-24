#!/usr/bin/env node

const command = process.argv[2];

async function main() {
  switch (command) {
    case "generate": {
      const args = process.argv.slice(3);
      const configPath = args.find((a) => !a.startsWith("--"));
      if (!configPath) {
        console.error(
          "Usage: meander generate <walkthrough.json> [--base-path <path>] [--asset-dir <dir>]",
        );
        process.exitCode = 1;
        return;
      }
      /* Flags:
       *   --base-path <path>  URL path prefix (Next.js semantics;
       *                       it's a path, not a URL)
       *   --asset-dir <dir>   Subdir under output for CSS/JS
       *                       assets; default is flat emission */
      const options: {
        basePath?: string | undefined;
        assetDir?: string | undefined;
        __proto__: null;
      } = { __proto__: null };
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--base-path") {
          options.basePath = args[++i];
        } else if (arg.startsWith("--base-path=")) {
          options.basePath = arg.slice("--base-path=".length);
        } else if (arg === "--asset-dir") {
          options.assetDir = args[++i];
        } else if (arg.startsWith("--asset-dir=")) {
          options.assetDir = arg.slice("--asset-dir=".length);
        }
      }
      const { generate } = await import("./generate.mts");
      await generate(configPath, options);
      break;
    }
    case "publish": {
      const configPath = process.argv[3];
      if (!configPath) {
        console.error("Usage: meander publish <path-to-walkthrough.json>");
        process.exitCode = 1;
        return;
      }
      const { publish } = await import("./publish.mts");
      await publish(configPath);
      break;
    }
    case "deploy-val": {
      const valName = process.argv[3] || "walkthrough";
      const { deployVal } = await import("./deploy-val.mts");
      await deployVal(valName);
      break;
    }
    case "serve": {
      /* Local preview server. Generate first, then serve so
       * the output reflects the latest source. Port defaults
       * to 8080; --port N and --base-path /prefix supported. */
      const args = process.argv.slice(3);
      const configPath = args.find((a) => !a.startsWith("--"));
      if (!configPath) {
        console.error("Usage: meander serve <walkthrough.json> [--port N] [--base-path <path>]");
        process.exitCode = 1;
        return;
      }
      const options: {
        port?: number | undefined;
        basePath?: string | undefined;
        __proto__: null;
      } = { __proto__: null };
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--port") {
          options.port = Number(args[++i]);
        } else if (arg.startsWith("--port=")) {
          options.port = Number(arg.slice("--port=".length));
        } else if (arg === "--base-path") {
          options.basePath = args[++i];
        } else if (arg.startsWith("--base-path=")) {
          options.basePath = arg.slice("--base-path=".length);
        }
      }
      const { generate } = await import("./generate.mts");
      await generate(configPath, { basePath: options.basePath });
      const { serve } = await import("./serve.mts");
      await serve(configPath, options);
      break;
    }
    default: {
      console.error(`meander — walkthrough generator with comments

Commands:
  meander generate <walkthrough.json>   Generate walkthrough HTML
  meander serve <walkthrough.json>      Generate + start local preview
  meander publish <walkthrough.json>    Publish HTML to Val Town blob storage
  meander deploy-val [val-name]         Deploy or update the Val Town val

Environment variables:
  VALTOWN_TOKEN       Val Town API bearer token (publish, deploy-val)
  WALKTHROUGH_USER    Basic auth username (deploy-val)
  WALKTHROUGH_PASS    Basic auth password (deploy-val)`);
      if (command) {
        console.error(`\nUnknown command: ${command}`);
      }
      process.exitCode = 1;
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
