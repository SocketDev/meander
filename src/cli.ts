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
      const { generate } = await import("./generate.js");
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
      const { publish } = await import("./publish.js");
      await publish(configPath);
      break;
    }
    case "deploy-val": {
      const valName = process.argv[3] || "walkthrough";
      const { deployVal } = await import("./deploy-val.js");
      await deployVal(valName);
      break;
    }
    default: {
      console.error(`meander — walkthrough generator with comments

Commands:
  meander generate <walkthrough.json>   Generate walkthrough HTML
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
