import { ConfigError, parseConfig } from "./config/config.js";
import type { AppConfig } from "./config/config.js";

/** Validates config, then starts the server. Resolves the exit code rather than exiting itself. */
export const run = async (
  env: NodeJS.ProcessEnv,
  start: (config: AppConfig) => Promise<void>,
  report: (message: string) => void,
): Promise<number> => {
  let config: AppConfig;
  try {
    config = parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      report(`Invalid configuration, not starting:\n${error.message}`);
      return 1;
    }
    throw error;
  }

  await start(config);
  return 0;
};
