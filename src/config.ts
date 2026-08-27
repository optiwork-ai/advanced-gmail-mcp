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
 * Pure account selection, split out from config loading so it can be tested
 * without touching the real accounts.json.
 *
 * Matching is EXACT on alias or on email, case-insensitive on both sides. The
 * old substring fallback (`a.email.includes(input)`) is deliberately gone: it
 * meant a typo or a bare token like "steve" could silently resolve to whichever
 * account happened to contain it, and account selection decides which mailbox
 * a message is SENT FROM. A near-miss must fail loudly, not guess.
 */
export function selectAccount(
  accounts: AccountConfig[],
  defaultAlias: string,
  input?: string,
): AccountConfig {
  const aliasList = accounts.map(a => a.alias).join(', ');

  if (!input || input.trim().length === 0) {
    const wanted = (defaultAlias ?? '').trim().toLowerCase();
    const fallback = accounts.find(a => a.alias.trim().toLowerCase() === wanted);
    if (!fallback) {
      throw new Error(
        `Config error: the default account "${defaultAlias}" is not present in accounts.json. `
        + `Available aliases: ${aliasList || '(none)'}.`
      );
    }
    return fallback;
  }

  const needle = input.trim().toLowerCase();

  const byAlias = accounts.find(a => a.alias.trim().toLowerCase() === needle);
  if (byAlias) return byAlias;

  const byEmail = accounts.find(a => a.email.trim().toLowerCase() === needle);
  if (byEmail) return byEmail;

  throw new Error(
    `Unknown account: "${input}". Valid aliases: ${aliasList || '(none)'}.`
  );
}

/**
 * Resolve an alias or email to an AccountConfig.
 * Accepts an exact alias or an exact email address (case-insensitive).
 */
export function resolveAccount(input?: string): AccountConfig {
  const config = loadConfig();
  return selectAccount(config.accounts ?? [], config.default, input);
}

export function getCredentialsPath(): string {
  return path.join(PROJECT_ROOT, 'credentials.json');
}

export function getTokenPath(account: AccountConfig): string {
  return path.join(PROJECT_ROOT, 'tokens', `${account.alias}.json`);
}
