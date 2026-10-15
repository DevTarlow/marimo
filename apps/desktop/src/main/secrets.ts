/**
 * The Electron half of secret storage: the cipher.
 *
 * `@marimo/runtime`'s `FileSecretStore` owns the file format and the
 * three-valued read. All this file supplies is the encryption itself, which only
 * Electron has.
 */
import {safeStorage} from 'electron';

import {PROVIDERS} from '@marimo/protocol';
import type {ProviderId} from '@marimo/protocol';

import {FileSecretStore} from '@marimo/runtime';
import type {AppPaths, SecretCipher} from '@marimo/runtime';

export const safeStorageCipher: SecretCipher = {
  available(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      // A keychain that throws is a keychain that is not there — on Linux, a
      // session with no D-Bus or no secret service.
      return false;
    }
  },
  encrypt: (value) => safeStorage.encryptString(value),
  decrypt: (payload) => safeStorage.decryptString(payload),
};

/** The store for one secret file, with the OS keychain behind it. */
export function secretStore(file: string, label: string): FileSecretStore {
  return new FileSecretStore(file, label, safeStorageCipher);
}

/**
 * The store for one provider's API key.
 *
 * The path comes from the resolved paths rather than being composed here, so the
 * file this writes is the file the headless runner reads — invariant 16 rests on
 * both processes naming the same one, and a second derivation of the name is
 * exactly how they would stop agreeing.
 *
 * The label names the provider, because it is what a refusal quotes back at the
 * user: "the Google Gemini API key could not be decrypted" says which key to
 * re-enter, and a bare "the API key" does not.
 */
export function providerSecretStore(
  paths: AppPaths,
  providerId: ProviderId,
): FileSecretStore {
  return secretStore(
    paths.providerSecrets[providerId],
    `${PROVIDERS[providerId].label} API key`,
  );
}
