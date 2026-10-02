import js from "@eslint/js"
import reactHooks from "eslint-plugin-react-hooks"
import tseslint from "typescript-eslint"

/**
 * Determinism is an invariant, not a habit. `localeCompare` without an explicit locale sorts by the
 * host's ICU default, so the same repo on two machines emits byte-different YAML; on a real React app
 * the locale order diverges from codepoint order at index 4 of 696 component keys.
 */
const NO_LOCALE_ORDERING = [
  {
    selector: "MemberExpression[property.name='localeCompare']",
    message:
      "localeCompare sorts by the host ICU locale and makes output machine-dependent. Use byCodepoint / the comparators in core/order.ts.",
  },
  {
    selector: "MemberExpression[object.name='Intl'][property.name='Collator']",
    message:
      "Intl.Collator sorts by locale and makes output machine-dependent. Use byCodepoint / the comparators in core/order.ts.",
  },
]

const EFFECT_MESSAGE =
  "useEffect/useLayoutEffect are banned in report-ui. Use useSyncExternalStore, event handlers, derived state, ref callbacks or key resets."

const NO_EFFECT = [
  {
    selector: "ImportDeclaration[source.value='react'] > ImportSpecifier[imported.name=/^use(Layout)?Effect$/]",
    message: EFFECT_MESSAGE,
  },
  {
    selector: "MemberExpression[object.name='React'][property.name=/^use(Layout)?Effect$/]",
    message: EFFECT_MESSAGE,
  },
]

const EFFECT_ALLOWLIST = []

const TYPESCRIPT_VALUE_BAN = {
  name: "typescript",
  allowTypeImports: true,
  message:
    "Adapters receive the compiler realm as ctx.ts and must never import it as a value. Type-only imports are fine.",
}

const PIPELINE_BAN = {
  group: ["**/pipeline/*", "**/pipeline/**"],
  message: "Adapters reach the kernel through context objects only.",
}

const TEMPLATE_COMPILER_PEERS = [
  { label: "Vue", group: ["vue", "vue/*", "@vue/*"], loader: "src/core/vue-compiler.ts" },
  { label: "Angular", group: ["@angular/*"], loader: "src/core/angular-compiler.ts" },
]

const TEMPLATE_COMPILER_BANS = TEMPLATE_COMPILER_PEERS.map(({ label, group, loader }) => ({
  group,
  message: `${label} is an optional peer: only ${loader} may load it. Take the compiler from ctx.`,
}))

const TEMPLATE_COMPILER_LOADERS = TEMPLATE_COMPILER_PEERS.map(({ loader }) => loader)

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      "coverage",
      "test/fixtures/**",
      "test/golden/**",
      "report-ui/dist",
      "playwright-report",
      "test-results",
      "e2e/.out",
      ".scratch/**",
      ".evidence/**",
      ".claude/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["src/*/probe.ts"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-syntax": ["error", ...NO_LOCALE_ORDERING],
    },
  },
  {
    /**
     * The adapter/kernel seam, enforced where it holds.
     *
     * The `typescript` half: every adapter takes the compiler realm through `ctx.ts` and imports the
     * module type-only, which erases. A plugin importing its own compiler can get a different realm
     * than the resolver that produced the `ts.SourceFile` it is handed, and `ts.isX()` then fails
     * silently. `allowTypeImports` keeps
     * `import type ts from "typescript"` legal and blocks any value import.
     *
     * The `pipeline` half: no adapter reaches into the kernel.
     *
     * There is no `core` ban: adapters import value exports from `core/ast`, `core/order`, `core/url`
     * and `core/strings`. The enforced boundary is the published surface (`src/index.ts` and
     * `src/cli/index.ts`), which tsup enforces structurally; the core/adapters split is a convention.
     */
    files: ["src/adapters/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [TYPESCRIPT_VALUE_BAN],
          patterns: [PIPELINE_BAN, ...TEMPLATE_COMPILER_BANS],
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: [...TEMPLATE_COMPILER_LOADERS, "src/adapters/**/*.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: TEMPLATE_COMPILER_BANS }],
    },
  },
  {
    files: ["report-ui/**/*.{ts,tsx}"],
    ...reactHooks.configs.flat.recommended,
  },
  {
    files: ["report-ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", ...NO_LOCALE_ORDERING, ...NO_EFFECT],
    },
  },
  ...(EFFECT_ALLOWLIST.length > 0
    ? [
        {
          files: EFFECT_ALLOWLIST,
          rules: {
            "no-restricted-syntax": ["error", ...NO_LOCALE_ORDERING],
          },
        },
      ]
    : []),
  {
    files: ["test/**/*.ts", "**/*.test.tsx", "report-ui/test/**", "e2e/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
  {
    /**
     * The only files allowed to call `localeCompare`, enumerated rather than globbed so a new one is a
     * deliberate act. Each measures the divergence the rule above prevents: the parity golden is
     * locale-ordered while appgraph's output is codepoint-ordered, and asserting where the two orders
     * first diverge requires computing both.
     */
    files: [
      "test/core/order.test.ts",
      "test/parity/assertions.ts",
      "test/parity/fixture.test.ts",
      "test/parity/gates.ts",
      "test/parity/golden.test.ts",
    ],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
)
