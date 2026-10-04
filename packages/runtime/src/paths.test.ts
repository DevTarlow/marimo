import {isAbsolute, join, relative} from 'node:path';

import {describe, expect, it} from 'vitest';

import {resolveAppPaths, secretFile, secretFileName} from './paths.js';

describe('resolveAppPaths', () => {
  const paths = resolveAppPaths('/data/marimo-agent');

  it('keeps every location under the directory it was given', () => {
    for (const value of [
      paths.sessions,
      paths.settings,
      paths.secretsDir,
      paths.profiles,
      paths.jobs,
      paths.skills,
    ]) {
      expect(isAbsolute(value)).toBe(true);
      expect(relative(paths.userData, value).startsWith('..')).toBe(false);
    }
  });

  it('gives every provider its own secret file', () => {
    const files = Object.values(paths.providerSecrets);
    expect(files.length).toBeGreaterThan(1);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) {
      expect(relative(paths.secretsDir, file).startsWith('..')).toBe(false);
    }
  });

  it('resolves from the argument rather than from the environment', () => {
    // Two calls with different roots must not share anything: this is what lets
    // the app and the headless runner point at the same directory deliberately,
    // and at a throwaway one in a test.
    const other = resolveAppPaths('/tmp/elsewhere');
    expect(other.jobs).toBe(join('/tmp/elsewhere', 'jobs.json'));
    expect(other.jobs).not.toBe(paths.jobs);
  });
});

describe('secretFileName', () => {
  it('keeps an ordinary name readable', () => {
    expect(secretFileName('deepseek')).toBe('deepseek.bin');
    expect(secretFileName('mcp:notes')).toBe('mcp-notes.bin');
  });

  /*
   * A connector name is the one part of a secret path a user types, so it is the
   * one part that can try to leave the directory.
   */
  it('cannot be walked out of the secrets directory', () => {
    for (const hostile of [
      '../../etc/passwd',
      '..',
      '/etc/shadow',
      'a/../../b',
      '....//....//x',
    ]) {
      const name = secretFileName(hostile);
      expect(name).not.toContain('/');
      expect(name).not.toContain('\\');
      expect(name.startsWith('.')).toBe(false);
      expect(relative('/data/secrets', join('/data/secrets', name))).toBe(name);
    }
  });

  it('falls back to a real file name when nothing survives', () => {
    expect(secretFileName('///')).toBe('secret.bin');
    expect(secretFileName('')).toBe('secret.bin');
    expect(secretFileName('..')).toBe('secret.bin');
  });

  it('bounds the length so a long name cannot break the path', () => {
    expect(secretFileName('a'.repeat(500)).length).toBeLessThanOrEqual(84);
  });

  it('folds case, because a case-insensitive filesystem would fold it anyway', () => {
    // The folding has to be deliberate rather than left to the filesystem: on
    // macOS and Windows `Notes.bin` and `notes.bin` are one file, so a name that
    // is only distinguished by case would silently share a secret with another.
    expect(secretFileName('Notes')).toBe(secretFileName('notes'));
    expect(secretFileName('DISCORD')).toBe('discord.bin');
  });

  it('keeps distinct safe characters distinct', () => {
    // `.` and `-` both survive sanitising, and they are not the same character.
    // Folding them together would be a collision invented for no reason.
    expect(secretFileName('my.server')).toBe('my.server.bin');
    expect(secretFileName('my-server')).toBe('my-server.bin');
  });
});

describe('secretFile', () => {
  it('puts a connector secret beside the provider keys', () => {
    const paths = resolveAppPaths('/data/marimo-agent');
    const file = secretFile(paths, 'mcp:notes');
    expect(relative(paths.secretsDir, file)).toBe('mcp-notes.bin');
  });
});
