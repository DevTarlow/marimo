/**
 * Secret storage, in the one place both processes can reach it.
 *
 * The preferred path is encryption at rest through the OS keychain. On Electron
 * that is `safeStorage`; in the headless job runner there is no `app` object and
 * therefore no `safeStorage` at all. Rather than two stores that disagree, the
 * cipher is *injected*: the app passes a `safeStorage`-backed implementation and
 * the runner passes none. Everything else — the file format, the refusal to
 * write a readable secret without permission, and the rule that one secret is
 * one file — is shared, so a key written by the app is found by the runner.
 *
 * A secret file says which it is in its own prefix:
 *
 * - `encrypted:<base64>` — written when a cipher was available. The only thing
 *   this store writes now.
 * - `plaintext:<base64>` — read, never written. A build that had a "store
 *   secrets as plain text" opt-in wrote these so a process with no keychain could
 *   read them, and an install that took that offer must go on working.
 *
 * Reads are three-valued on purpose. "No secret yet" and "a secret I cannot
 * decrypt" are different facts, and only the second one is a problem the user has
 * to fix; collapsing them into an empty string is what makes a misconfigured
 * install look like an unconfigured one. A caller that cannot read a connector
 * token must say so rather than dialling the server without it.
 */
import {mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';

const ENCRYPTED_PREFIX = 'encrypted:';
const PLAINTEXT_PREFIX = 'plaintext:';

/**
 * Encryption at rest, as the platform provides it.
 *
 * Implemented by the app over Electron's `safeStorage`; left undefined in the
 * runner. `available()` is asked every time rather than cached, because on Linux
 * a keyring that was locked at launch can become usable later in the session.
 */
export interface SecretCipher {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(payload: Buffer): string;
}

/** What a secret read found. */
export type SecretRead =
  | {state: 'present'; value: string}
  /** No secret has been stored, or the file has been cleared. */
  | {state: 'absent'}
  /**
   * A secret exists but this process cannot produce it — an encrypted file with
   * no cipher, or one encrypted under a keychain that is no longer readable.
   */
  | {state: 'unreadable'; reason: string};

/**
 * One secret in one file.
 *
 * `label` names the secret in the refusal below, so a user who is told "the API
 * key cannot be encrypted" is told about the thing they were actually saving.
 */
export class FileSecretStore {
  constructor(
    private readonly file: string,
    private readonly label = 'API key',
    private readonly cipher?: SecretCipher,
  ) {}

  /** Whether this process can encrypt at rest on this machine. */
  isEncryptionAvailable(): boolean {
    try {
      return this.cipher?.available() ?? false;
    } catch {
      // A keychain that throws is a keychain that is not there.
      return false;
    }
  }

  async has(): Promise<boolean> {
    return (await this.read()).state === 'present';
  }

  async read(): Promise<SecretRead> {
    let raw: string;
    try {
      raw = (await readFile(this.file, 'utf8')).trim();
    } catch {
      return {state: 'absent'};
    }
    if (raw.length === 0) {
      return {state: 'absent'};
    }

    if (raw.startsWith(PLAINTEXT_PREFIX)) {
      return {
        state: 'present',
        value: Buffer.from(
          raw.slice(PLAINTEXT_PREFIX.length),
          'base64',
        ).toString('utf8'),
      };
    }

    if (raw.startsWith(ENCRYPTED_PREFIX)) {
      if (!this.isEncryptionAvailable()) {
        return {
          state: 'unreadable',
          reason:
            `The ${this.label} is encrypted and this process cannot decrypt it: ` +
            'no OS keychain is available to it. Re-enter it from a session that ' +
            'has one.',
        };
      }
      try {
        const payload = Buffer.from(
          raw.slice(ENCRYPTED_PREFIX.length),
          'base64',
        );
        return {state: 'present', value: this.cipher!.decrypt(payload)};
      } catch {
        // Encrypted under a keychain that is no longer readable. Treated as
        // unreadable rather than absent, so the user is told to re-enter it
        // instead of silently getting a key-less agent.
        return {
          state: 'unreadable',
          reason:
            `The ${this.label} could not be decrypted — it was encrypted by a ` +
            'keychain this machine no longer provides. Enter it again in Settings.',
        };
      }
    }

    return {
      state: 'unreadable',
      reason: `The ${this.label} file is not in a format this app wrote.`,
    };
  }

  /** The value, or an empty string for anything that is not a readable secret. */
  async get(): Promise<string> {
    const read = await this.read();
    return read.state === 'present' ? read.value : '';
  }

  /**
   * Stores a secret, encrypted.
   *
   * There is no plain-text path any more, and no option to ask for one: the
   * opt-in existed so a windowless process could read a key, and the app no
   * longer has a key that one needs. A machine with no keychain therefore cannot
   * store a connector token at all, which is said plainly rather than papered
   * over — writing it readable would be deciding for the user that a token is
   * not worth encrypting.
   */
  async set(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      await this.clear();
      return;
    }

    await mkdir(dirname(this.file), {recursive: true});

    if (!this.isEncryptionAvailable()) {
      throw new Error(
        `This system has no available keychain, so the ${this.label} cannot be ` +
          'stored. It would have to be written to disk readable by anything, ' +
          'which this app will not do unasked.',
      );
    }

    const encrypted = this.cipher!.encrypt(trimmed).toString('base64');
    await writeFile(this.file, `${ENCRYPTED_PREFIX}${encrypted}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async clear(): Promise<void> {
    await rm(this.file, {force: true});
  }
}
