import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';

function logPath(): string {
  return process.env.GMAIL_MCP_LOG_PATH
    || join(homedir(), '.cache', 'gmail-mcp', 'server.log');
}

function disabled(): boolean {
  return process.env.GMAIL_MCP_LOG_DISABLE === '1';
}

const ensuredDirs = new Set<string>();

function ensureDir(path: string): boolean {
  const dir = dirname(path);
  if (ensuredDirs.has(dir)) return true;
  try {
    mkdirSync(dir, { recursive: true });
    ensuredDirs.add(dir);
    return true;
  } catch {
    return false;
  }
}

export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Record<string, unknown> = {},
): void {
  if (disabled()) return;
  const path = logPath();
  if (!ensureDir(path)) return;
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, message, ...fields });
    appendFileSync(path, line + '\n');
  } catch {
    // Best-effort — never let logging break the server.
  }
}

export function getLogPath(): string {
  return logPath();
}
