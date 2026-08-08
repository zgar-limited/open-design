import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  cacheTokenFromTokens,
  canRefresh,
  clearToken,
  isFresh,
  loadToken,
  saveToken,
  type SafeStorage,
} from "../../src/feishu/token-cache.js";

// Identity-backed fake safeStorage: encrypt returns the plain utf8 bytes, and
// decrypt reverses the base64 form saveToken writes. The real Electron
// safeStorage has the same Buffer round-trip shape.
const fakeSafeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(plain, "utf8"),
  decryptString: (encrypted) => encrypted.toString("utf8"),
};

const token = cacheTokenFromTokens(
  { accessToken: "a", refreshToken: "r", expiresIn: 7200, refreshExpiresIn: 2_592_000 },
  { tenantKey: "ten", name: "Rain" },
  1_000_000,
);

describe("cacheTokenFromTokens", () => {
  it("converts expires_in (seconds) to epoch-ms expiry relative to now", () => {
    expect(token.expiresAt).toBe(1_000_000 + 7_200_000);
    expect(token.refreshExpiresAt).toBe(1_000_000 + 2_592_000_000);
    expect(token.tenantKey).toBe("ten");
  });
});

describe("isFresh / canRefresh", () => {
  it("is fresh before access expiry (minus skew), refreshable before refresh expiry", () => {
    expect(isFresh(token, 1_000_000)).toBe(true);
    expect(isFresh(token, token.expiresAt)).toBe(false); // skew pushes it stale early
    expect(canRefresh(token, token.expiresAt)).toBe(true);
    expect(canRefresh(token, token.refreshExpiresAt)).toBe(false);
  });
});

describe("saveToken / loadToken round-trip", () => {
  it("persists encrypted and reloads the same token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feishu-tok-"));
    const path = join(dir, "feishu-token.json");
    try {
      await saveToken(path, token, fakeSafeStorage);
      const loaded = await loadToken(path, fakeSafeStorage);
      expect(loaded).toEqual(token);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns null when no token file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feishu-tok-"));
    try {
      expect(await loadToken(join(dir, "nope.json"), fakeSafeStorage)).toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("returns null when the stored blob fails to decrypt/parse (treat as logged out)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feishu-tok-"));
    const path = join(dir, "feishu-token.json");
    try {
      await saveToken(path, token, fakeSafeStorage);
      // Corrupt: replace the file with undecryptable bytes.
      const { writeFile } = await import("node:fs/promises");
      await writeFile(path, "not-valid-base64-payload", "utf8");
      expect(await loadToken(path, fakeSafeStorage)).toBeNull();
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

describe("clearToken", () => {
  it("removes the token file (idempotent)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "feishu-tok-"));
    const path = join(dir, "feishu-token.json");
    try {
      await saveToken(path, token, fakeSafeStorage);
      await clearToken(path);
      expect(await loadToken(path, fakeSafeStorage)).toBeNull();
      await clearToken(path); // no throw on missing
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
