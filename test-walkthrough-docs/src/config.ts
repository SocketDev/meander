/**
 * Configuration for the application.
 *
 * This sets up all the necessary defaults.
 */

export const DEFAULT_PORT = 3000;
export const API_VERSION = "v1";

/**
 * Load configuration from environment variables.
 */
export function loadConfig(): { port: number; version: string } {
  return {
    port: parseInt(process.env.PORT ?? "3000", 10),
    version: API_VERSION,
  };
}
