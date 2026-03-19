#!/usr/bin/env node

const command = process.argv[2];

async function main() {
  switch (command) {
    case "generate": {
      const configPath = process.argv[3];
      if (!configPath) {
        console.error("Usage: meander generate <path-to-walkthrough.json>");
        process.exitCode = 1;
        return;
      }
      const { generate } = await import("./generate.js");
      await generate(configPath);
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
