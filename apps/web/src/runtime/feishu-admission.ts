/**
 * Build-time flag for the xDesign fork's Feishu admission gate.
 *
 * When a packaged build enables the gate (OD_FEISHU_ADMISSION), tools/pack
 * passes NEXT_PUBLIC_OD_FEISHU_ADMISSION=true to `next build`, which inlines the
 * value into this module. The web uses it to suppress the upstream vela/AMR
 * cloud-login entry — Feishu is the sole identity, authenticated at the
 * packaged-app gate before this bundle even loads. Unset (false) for upstream
 * and non-Feishu builds, so the cloud-login entry shows as usual.
 */
export function feishuAdmissionEnabled(): boolean {
  return process.env.NEXT_PUBLIC_OD_FEISHU_ADMISSION === "true";
}
