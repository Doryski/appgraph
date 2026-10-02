import { isTemplateStale } from "../../scripts/generate-assets.js"

export const STALE_TEMPLATE_MESSAGE =
  "Report template is missing or stale — run `pnpm assets` (or use `pnpm test`, which does it for you)."

export default function setup(): void {
  if (isTemplateStale()) throw new Error(STALE_TEMPLATE_MESSAGE)
}
