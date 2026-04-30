/**
 * Shared configuration loader.
 */

import fs from 'fs/promises';

export const DEFAULT_CONFIG_PATH =
  process.env.DEVNERDS_CONFIG_PATH || './config/devnerds.config.json';

export async function loadConfig(configPath) {
  const data = await fs.readFile(configPath || DEFAULT_CONFIG_PATH, 'utf-8');
  return JSON.parse(data);
}
