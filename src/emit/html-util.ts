
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch)

export const byCodepoint = (a: string, b: string): number => {
  if (a === b) return 0
  return a < b ? -1 : 1
}

export { isApiRouteScreen as isApiScreen } from "../core/graph/screens.js"
