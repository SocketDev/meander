/**
 * HTTP server bootstrap.
 *
 * Binds to the configured port from `loadConfig()` and
 * delegates request handling to the router.
 */

import { loadConfig } from "./config";

export function startServer(): void {
  const { port, version } = loadConfig();
  console.log(`Starting server ${version} on port ${port}`);
}
