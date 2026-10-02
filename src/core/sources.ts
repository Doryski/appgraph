/**
 * §11 rule 7: adapters are ordered by (detectionPrecedence, name) — never by registration or
 * filesystem order. The precedence list is the §10.1 display order: file-convention sources are
 * framework ground truth, a code-literal parse is a guess. It orders; it never picks a winner.
 */
export const SOURCE_PRECEDENCE = [
  "next-app",
  "expo-router",
  "next-pages",
  "react-router-framework",
  "nuxt",
  "tanstack-router",
  "vue-router",
  "angular",
  "react-navigation",
  "adminjs",
  "react-router",
  "wouter",
  "state-screens",
  "manifest-activation",
] as const
