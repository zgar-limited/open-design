/**
 * xDesign brand-injecting pack wrapper.
 *
 * Loads the fork brand config from xdesign/brand/brand.json, exposes it to
 * `tools-pack` through the OD_PRODUCT_NAME / OD_APP_ID / OD_MAC_ICON /
 * OD_WIN_ICON / OD_LINUX_ICON env vars (the brand overlay seam in
 * tools/pack/src/brand.ts), and forwards every CLI argument verbatim. Upstream
 * `tools-pack` behavior is untouched when these env vars are absent, so this
 * wrapper is the single place the fork opts in to its own identity.
 *
 * Run it from the repo root, e.g.:
 *   node --experimental-strip-types xdesign/scripts/pack.ts mac build --to dmg
 *   node --experimental-strip-types xdesign/scripts/pack.ts mac build --to dmg --namespace xdesign-local
 *
 * Everything after the script path is forwarded to `pnpm tools-pack`.
 */
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

interface BrandConfig {
  productName: string;
  appId?: string;
}

const brandPath = join(repoRoot, "xdesign", "brand", "brand.json");
const brand = JSON.parse(readFileSync(brandPath, "utf8")) as BrandConfig;

if (!brand.productName || typeof brand.productName !== "string") {
  throw new Error(`xdesign/brand/brand.json must define a string productName: ${brandPath}`);
}

// Per-platform brand icons. Each is only forwarded when the file exists, so a
// fork that has only produced a mac icon so far still falls back to the upstream
// win/linux icons for the other platforms (rather than pointing at a missing file).
const macIcon = join(repoRoot, "xdesign", "brand", "icon.icns");
const winIcon = join(repoRoot, "xdesign", "brand", "icon.ico");
const linuxIcon = join(repoRoot, "xdesign", "brand", "icon.png");

const env: NodeJS.ProcessEnv = {
  ...process.env,
  OD_PRODUCT_NAME: brand.productName,
};
if (brand.appId) {
  env.OD_APP_ID = brand.appId;
}
if (existsSync(macIcon)) env.OD_MAC_ICON = macIcon;
if (existsSync(winIcon)) env.OD_WIN_ICON = winIcon;
if (existsSync(linuxIcon)) env.OD_LINUX_ICON = linuxIcon;

// Feishu admission gate (xDesign fork). When xdesign/brand/feishu.json is
// present (gitignored — holds app_id/app_secret/tenant_id), turn the gate ON and
// forward the creds so tools-pack bakes them into the packaged config. Missing
// file (or OD_FEISHU_ADMISSION already set in the ambient env) leaves the gate
// off, preserving upstream boot. feishu.example.json is the template.
interface FeishuConfig {
  appId?: string;
  appSecret?: string;
  tenantKey?: string;
  baseUrl?: string;
}
const feishuConfigPath = join(repoRoot, "xdesign", "brand", "feishu.json");
if (process.env.OD_FEISHU_ADMISSION !== "true" && existsSync(feishuConfigPath)) {
  const feishu = JSON.parse(readFileSync(feishuConfigPath, "utf8")) as FeishuConfig;
  if (feishu.appId && feishu.appSecret && feishu.tenantKey) {
    env.OD_FEISHU_ADMISSION = "true";
    env.OD_FEISHU_APP_ID = feishu.appId;
    env.OD_FEISHU_APP_SECRET = feishu.appSecret;
    env.OD_FEISHU_TENANT_KEY = feishu.tenantKey;
    if (feishu.baseUrl) env.OD_FEISHU_BASE_URL = feishu.baseUrl;
  } else {
    throw new Error(
      "xdesign/brand/feishu.json must define appId, appSecret, and tenantKey (see feishu.example.json)",
    );
  }
}

const args = process.argv.slice(2);
const child = spawn("pnpm", ["tools-pack", ...args], {
  stdio: "inherit",
  env,
  shell: process.platform === "win32",
});

child.on("exit", (code) => {
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
