import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

export interface AccountConfig {
  email: string;
  alias: string;
}

interface Config {
  accounts: AccountConfig[];
  default: string;
}

let _config: Config | null = null;

function loadConfig(): Config {
  if (_config) return _config;

  const configPath = path.join(PROJECT_ROOT, 'accounts.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      'accounts.json not found. Copy accounts.example.json to accounts.json and add your accounts.'
    );
  }

  _config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return _config!;
}

export function getAccounts(): AccountConfig[] {
  return loadConfig().accounts;
}

export function getDefaultAlias(): string {
  return loadConfig().default;
}

/**
 * Resolve an alias or email to an AccountConfig.
 * Accepts: alias (e.g. "work"), full email, or partial match.
 */
export function resolveAccount(input?: string): AccountConfig {
  const config = loadConfig();

  if (!input) {
    return config.accounts.find(a => a.alias === config.default)!;
  }

  const lower = input.toLowerCase();

  // Exact alias match
  const byAlias = config.accounts.find(a => a.alias === lower);
  if (byAlias) return byAlias;

  // Exact email match
  const byEmail = config.accounts.find(a => a.email === lower);
  if (byEmail) return byEmail;

  // Partial email match
  const byPartial = config.accounts.find(a => a.email.includes(lower));
  if (byPartial) return byPartial;

  throw new Error(
    `Unknown account: "${input}". Valid aliases: ${config.accounts.map(a => a.alias).join(', ')}`
  );
}

export function getCredentialsPath(): string {
  return path.join(PROJECT_ROOT, 'credentials.json');
}

export function getTokenPath(account: AccountConfig): string {
  return path.join(PROJECT_ROOT, 'tokens', `${account.alias}.json`);
}
