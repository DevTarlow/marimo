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
 * - `encrypted:<base64>` — written when a cipher was available.
 * - `plaintext:<base64>` — written only after the user accepted that it would
 *   be readable on disk, which is why the choice is recorded rather than
 *   implied.
 *
 * Reads are three-valued on purpose. "No key yet" and "a key I cannot decrypt"
 * are different facts, and only the second one is a problem the user has to fix;
 * collapsing them into an empty string is what makes a misconfigured install look
 * like an unconfigured one. The runner leans on this: a scheduled job that cannot
 * read the key must say so in its recorded outcome rather than failing obscurely
 * at the provider.
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

export interface SecretWriterOptions {
  /**
   * Whether the user has accepted an unencrypted secret when no keychain is
   * available. Required for the headless runner, which has no cipher at all.
   */
  allowPlaintext: boolean;
}

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
            'no OS keychain is available to it. Enable "Store secrets as plain ' +
            'text" in Settings if you want scheduled jobs to run while the app ' +
            'is closed.',
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

  async set(value: string, options: SecretWriterOptions): Promise<void> {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      await this.clear();
      return;
    }

    await mkdir(dirname(this.file), {recursive: true});

    /*
     * Consent first, and it wins over the keychain.
     *
     * The only reason to accept a readable secret is that something without a
     * keychain has to read it — the headless job runner. Encrypting anyway
     * because a keychain happens to be available would take the consent and
     * produce the opposite of what was consented to: a key the background
     * service cannot use, while the settings screen says it can. That is the
     * worst shape a security setting can take, so the ordering here is the
     * point rather than an accident of the branches.
     */
    if (!options.allowPlaintext && this.isEncryptionAvailable()) {
      const encrypted = this.cipher!.encrypt(trimmed).toString('base64');
      await writeFile(this.file, `${ENCRYPTED_PREFIX}${encrypted}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      return;
    }

    if (!options.allowPlaintext) {
      throw new Error(
        `This system has no available keychain, so the ${this.label} cannot be ` +
          'encrypted. Enable "Store secrets as plain text" in Settings if you ' +
          'accept that it will be readable on disk.',
      );
    }

    const encoded = Buffer.from(trimmed, 'utf8').toString('base64');
    await writeFile(this.file, `${PLAINTEXT_PREFIX}${encoded}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  async clear(): Promise<void> {
    await rm(this.file, {force: true});
  }
}
