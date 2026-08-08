/**
 * Encrypted on-disk cache for the Feishu admission token.
 *
 * Uses Electron `safeStorage` (OS keychain-backed: macOS Keychain / DPAPI /
 * libsecret) so the cached tokens are encrypted at rest, not plaintext on disk.
 * The cached token lets the gate skip the Feishu login on subsequent launches
 * and lets the periodic re-validation re-check admission without re-prompting.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { FeishuTokens, FeishuUserInfo } from "./oauth.js";

/** Minimal view of Electron `safeStorage` — accepts a base64 string on decrypt. */
export type SafeStorage = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer | string): string;
};

export type CachedFeishuToken = {
  accessToken: string;
  refreshToken: string;
  tenantKey: string;
  name: string;
  /** Epoch ms when accessToken expires. */
  expiresAt: number;
  /** Epoch ms when refreshToken expires. */
  refreshExpiresAt: number;
};

/** Refresh a little before the real expiry so we never hand the app an expired token. */
const TOKEN_SKEW_MS = 60_000;

export function isFresh(token: CachedFeishuToken, now: number): boolean {
  return now < token.expiresAt - TOKEN_SKEW_MS;
}

export function canRefresh(token: CachedFeishuToken, now: number): boolean {
  return now < token.refreshExpiresAt - TOKEN_SKEW_MS;
}

/** Build the cached shape from a fresh OAuth exchange (expires_in is in seconds). */
export function cacheTokenFromTokens(
  tokens: FeishuTokens,
  info: FeishuUserInfo,
  now: number,
): CachedFeishuToken {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tenantKey: info.tenantKey,
    name: info.name,
    expiresAt: now + tokens.expiresIn * 1000,
    refreshExpiresAt: now + tokens.refreshExpiresIn * 1000,
  };
}

export async function saveToken(
  filePath: string,
  token: CachedFeishuToken,
  safeStorage: SafeStorage,
): Promise<void> {
  const encrypted = safeStorage.encryptString(JSON.stringify(token)).toString("base64");
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${encrypted}\n`, "utf8");
}

export async function loadToken(
  filePath: string,
  safeStorage: SafeStorage,
): Promise<CachedFeishuToken | null> {
  let raw: string;
  try {
    raw = (await readFile(filePath, "utf8")).trim();
  } catch {
    return null; // No cached token yet (first launch).
  }
  if (raw.length === 0) return null;
  // A decrypt/parse failure means the cache is unusable (corrupted, migrated
  // OS keychain, etc.); treat it as logged out rather than blocking the boot.
  try {
    const plain = safeStorage.decryptString(raw);
    return JSON.parse(plain) as CachedFeishuToken;
  } catch {
    return null;
  }
}

export async function clearToken(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}
