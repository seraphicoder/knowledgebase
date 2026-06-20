import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Loads the repo-root .env into process.env using Node's built-in loader.
// Import this FIRST (before env.ts is read) in any runnable entry point
// (server, scripts). Tests don't need it — they mock external services.

const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  resolve(here, '../../../../.env'), // repo root from src/lib
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), '../../.env'),
];

for (const path of candidates) {
  if (existsSync(path)) {
    process.loadEnvFile(path);
    break;
  }
}
