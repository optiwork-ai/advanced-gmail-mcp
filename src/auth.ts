#!/usr/bin/env node
/**
 * Auth CLI for gmail-mcp.
 *
 * Usage:
 *   npx tsx src/auth.ts <alias|email>   — Authenticate one account
 *   npx tsx src/auth.ts --check          — Show status of all accounts
 *   npx tsx src/auth.ts                  — Authenticate all accounts sequentially
 */

import { getAccounts, resolveAccount } from './config.js';
import { authenticateAccount, checkAuthStatus } from './gmail/auth.js';

async function main() {
  const arg = process.argv[2];

  if (arg === '--check') {
    checkAuthStatus();
    return;
  }

  if (arg) {
    // Authenticate a single account
    try {
      const account = resolveAccount(arg);
      await authenticateAccount(account);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

  // No argument: authenticate all accounts sequentially
  const accounts = getAccounts();
  console.log(`\nAuthenticating all ${accounts.length} accounts...\n`);

  for (const account of accounts) {
    try {
      await authenticateAccount(account);
    } catch (err) {
      console.error(`Failed to authenticate ${account.email}:`, err);
    }
  }
}

main().catch(console.error);
