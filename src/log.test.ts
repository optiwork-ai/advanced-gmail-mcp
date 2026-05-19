import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { log } from './log.js';

describe('log', () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'gmail-mcp-log-'));
    logPath = join(tmpDir, 'server.log');
    process.env.GMAIL_MCP_LOG_PATH = logPath;
    process.env.GMAIL_MCP_LOG_DISABLE = '';
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.GMAIL_MCP_LOG_PATH;
    delete process.env.GMAIL_MCP_LOG_DISABLE;
  });

  it('appends one JSON line per call with timestamp + level + message + fields', () => {
    log('info', 'hello', { foo: 'bar', n: 1 });
    log('warn', 'retrying', { status: 503 });
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const first = JSON.parse(lines[0]);
    expect(first.level).toBe('info');
    expect(first.message).toBe('hello');
    expect(first.foo).toBe('bar');
    expect(first.n).toBe(1);
    expect(typeof first.ts).toBe('string');
    const second = JSON.parse(lines[1]);
    expect(second.level).toBe('warn');
    expect(second.status).toBe(503);
  });

  it('writes nothing when GMAIL_MCP_LOG_DISABLE=1', () => {
    process.env.GMAIL_MCP_LOG_DISABLE = '1';
    log('info', 'should not appear');
    expect(existsSync(logPath)).toBe(false);
  });
});
