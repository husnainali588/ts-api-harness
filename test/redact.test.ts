import { describe, expect, it } from 'vitest';
import { findSecrets, redact } from '../core/redact.js';
import { scrubbedEnv } from '../core/exec.js';

describe('redact', () => {
  it('replaces the literal value of secret-looking env vars and common key formats', () => {
    const env = { HARNESS_TEST_API_KEY: 'value-1234567890', HOME: '/home/x' };
    const text = `key=value-1234567890 gh=ghp_${'a'.repeat(36)} or=sk-or-v1-${'b'.repeat(40)} home=/home/x`;
    const out = redact(text, env);
    expect(out).not.toContain('value-1234567890');
    expect(out).toContain('[REDACTED:HARNESS_TEST_API_KEY]');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('sk-or-');
    expect(out).toContain('home=/home/x');
  });

  it('finds secrets by name, never by value', () => {
    const found = findSecrets('token value-1234567890', { MY_TOKEN: 'value-1234567890' });
    expect(found).toEqual(['value of MY_TOKEN']);
    expect(findSecrets('nothing here', {})).toEqual([]);
  });
});

describe('scrubbedEnv', () => {
  it('drops secret-looking variables from subprocess environments', () => {
    process.env.HARNESS_SCRUB_TEST_KEY = 'x';
    process.env.HARNESS_SCRUB_TEST_TOKEN = 'x';
    process.env.HARNESS_SCRUB_VISIBLE = 'x';
    const env = scrubbedEnv();
    expect(env).not.toHaveProperty('HARNESS_SCRUB_TEST_KEY');
    expect(env).not.toHaveProperty('HARNESS_SCRUB_TEST_TOKEN');
    expect(env).toHaveProperty('HARNESS_SCRUB_VISIBLE');
    delete process.env.HARNESS_SCRUB_TEST_KEY;
    delete process.env.HARNESS_SCRUB_TEST_TOKEN;
    delete process.env.HARNESS_SCRUB_VISIBLE;
  });
});
