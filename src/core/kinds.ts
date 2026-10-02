import type { KindRule, NodeKind } from "./model.js"
import { SCRIPT_EXTENSION_PATTERN } from "./extensions.js"

export type KindMatchInput = {
  readonly file: string
}

const basenameOf = (file: string): string => file.slice(file.lastIndexOf("/") + 1)

const compiledPatterns = new Map<string, RegExp | null>()

const compilePattern = (pattern: string): RegExp | null => {
  try {
    return new RegExp(pattern)
  } catch {
    return null
  }
}

const patternOf = (pattern: string): RegExp | null => {
  if (!compiledPatterns.has(pattern)) compiledPatterns.set(pattern, compilePattern(pattern))
  return compiledPatterns.get(pattern) ?? null
}

/** A pattern that does not compile matches nothing; the config loader reports it as `config/invalid-field`. */
export const matchesPattern = (pattern: string, value: string): boolean => patternOf(pattern)?.test(value) ?? false

const matchesRule = (rule: KindRule, input: KindMatchInput): boolean => {
  const { match } = rule
  const hasConstraint = match.pathPrefix !== undefined || match.pathRegex !== undefined || match.fileRegex !== undefined
  if (!hasConstraint) return true

  if (match.pathPrefix !== undefined && !input.file.startsWith(match.pathPrefix)) return false
  if (match.pathRegex !== undefined && !matchesPattern(match.pathRegex, input.file)) return false
  if (match.fileRegex !== undefined && !matchesPattern(match.fileRegex, basenameOf(input.file))) return false
  return true
}

/**
 * §6.4: the single evaluator for what a file is — its kind, whether `uses` edges traverse it, and
 * whether it may hold a screen entry. Ties on `priority`
 * (default 0) resolve to the earliest rule in array order — "default = rule order within an
 * adapter", per the model's own doc comment on `KindRule.priority`. A rule from the config file, the
 * `analyze()` options or the CLI that sets no `priority` ranks at `CONFIG_KIND_RULE_PRIORITY`, above
 * every built-in rule, and later layers' rules come first — so a user rule overrides a preset one.
 */
export const CONFIG_KIND_RULE_PRIORITY = 100

export const selectKindRule = (rules: readonly KindRule[], input: KindMatchInput): KindRule | null => {
  let best: KindRule | null = null
  let bestPriority = Number.NEGATIVE_INFINITY

  for (const rule of rules) {
    if (!matchesRule(rule, input)) continue
    const priority = rule.priority ?? 0
    if (best === null || priority > bestPriority) {
      best = rule
      bestPriority = priority
    }
  }

  return best
}

export type KindEvaluation = {
  readonly kind: NodeKind
  readonly traversable: boolean
  readonly screenEntry: boolean
  readonly rule: KindRule | null
}

export const DEFAULT_KIND: NodeKind = "other"

export const evaluateKind = (rules: readonly KindRule[], input: KindMatchInput): KindEvaluation => {
  const rule = selectKindRule(rules, input)
  if (rule === null) return { kind: DEFAULT_KIND, traversable: false, screenEntry: false, rule: null }
  return { kind: rule.kind, traversable: rule.traversable, screenEntry: rule.screenEntry, rule }
}

// The three predicates this module is the single source of truth for (the first three of §6.4's four questions). "Is
// this file in scope at all" is deliberately NOT here: `project.sourceRoots` / `ProjectPaths.contains`
// answer it.
export const kindOf = (rules: readonly KindRule[], input: KindMatchInput): NodeKind => evaluateKind(rules, input).kind

/**
 * §7.8: a `useX` file is traversable on its NAME, whatever directory it sits in, so the name rule is
 * a UNION with `KindRule.traversable`, not a fallback for when no rule matched.
 *
 * The separator class is `[-_A-Z]` and not `[A-Z]`: a camelCase-only class would make the whole
 * predicate dead on a kebab-case repo (`use-page-label.ts`) or a snake_case one (`use_page_label.ts`). `user.ts` / `used.ts` still do not match — the character after
 * `use` has to be a word boundary of some kind.
 */
export const HOOK_FILE = new RegExp(`/use[-_A-Z][A-Za-z0-9_-]*\\.${SCRIPT_EXTENSION_PATTERN}$`)

/**
 * The rule half and the name half are answered together here because `uses` has a producer (the
 * component-tree extractor) and a consumer (the walk's reachability closure): a consumer applying a
 * STRICTER predicate deletes edges the producer legitimately emitted, and does it silently.
 */
export const isTraversable = (rules: readonly KindRule[], input: KindMatchInput): boolean =>
  evaluateKind(rules, input).traversable || HOOK_FILE.test(input.file)

export const isScreenEntry = (rules: readonly KindRule[], input: KindMatchInput): boolean =>
  evaluateKind(rules, input).screenEntry

export type DirectoryVocabularyEntry = {
  readonly names: readonly string[]
  readonly kind: NodeKind
  readonly traversable: boolean
  readonly screenEntry: boolean
}

// The directory-name vocabulary. `traversable: true` marks the kinds that feed the `uses`
// reachability closure; `screenEntry: true` marks the only kind file-convention screens are expected
// to live in, stated as a positive rule rather than a path exclusion.
//
// `shared` is deliberately NOT traversable: §10.5 marks only `services|api`, `stores|state` and `hooks`
// traversable, and a shared/utils/lib grab-bag holds constants, types and formatters whose reachability
// says nothing about what a screen does. A repo that wants it traversable widens it with one config
// `kindRule` — the narrow default is the one that is reproducible from the directory names alone.
//
// `server` joins the service family because a server-function data layer (`createServerFn`,
// `"use server"`) IS the app's API client, just co-located: leaving it out keeps `src/server/**` out of
// the graph entirely and collapses every `createServerFn` call behind it into almost no endpoints.
export const DIRECTORY_VOCABULARY: readonly DirectoryVocabularyEntry[] = [
  { names: ["modules", "features", "pages", "screens"], kind: "module", traversable: false, screenEntry: true },
  { names: ["layouts"], kind: "layout", traversable: false, screenEntry: false },
  { names: ["components", "ui"], kind: "ui", traversable: false, screenEntry: false },
  { names: ["services", "api", "clients", "server"], kind: "service", traversable: true, screenEntry: false },
  { names: ["stores", "store", "state"], kind: "store", traversable: true, screenEntry: false },
  { names: ["hooks"], kind: "hook", traversable: true, screenEntry: false },
  { names: ["shared", "utils", "helpers", "lib"], kind: "shared", traversable: false, screenEntry: false },
]

/** The data-layer half of the vocabulary, exported so presets state it as rules rather than restate it. */
export const TRAVERSABLE_VOCABULARY: readonly DirectoryVocabularyEntry[] = DIRECTORY_VOCABULARY.filter(
  (entry) => entry.traversable,
)

const SHARED_FAMILY = DIRECTORY_VOCABULARY.filter((entry) => entry.kind === "shared")

const TRAVERSABLE_FAMILY = TRAVERSABLE_VOCABULARY

// Above `ALIAS_PRIORITY`: `src/shared/hooks/` is BOTH `src/shared/` (an alias target on most repos) and
// a hooks directory, and the deeper, more specific name is the one that describes the file.
const NESTED_PRIORITY = 15
const ALIAS_PRIORITY = 10
const VOCABULARY_PRIORITY = 5
const DEFAULT_PRIORITY = 0

const stripWildcard = (value: string): string => value.replace(/\/\*$/, "").replace(/^\.\//, "")

const vocabularyFor = (targetPrefix: string): DirectoryVocabularyEntry | null => {
  const segments = targetPrefix.split("/")
  return DIRECTORY_VOCABULARY.find((entry) => entry.names.some((name) => segments.includes(name))) ?? null
}

export type DeriveKindRulesOptions = {
  readonly tsconfigPaths?: Readonly<Record<string, readonly string[]>>
  readonly sourceRootsRel?: readonly string[]
}

/**
 * Derives default `KindRule[]` from two host-project signals: tsconfig path
 * aliases (e.g. `@/modules/*` → `src/modules/*`) and the directory-name vocabulary applied under
 * each configured source root. Alias-derived rules win ties over vocabulary-derived rules over the
 * catch-all `other` default, via `priority`.
 */
export const deriveDefaultKindRules = (options: DeriveKindRulesOptions = {}): readonly KindRule[] => {
  const rules: KindRule[] = []

  for (const targets of Object.values(options.tsconfigPaths ?? {})) {
    for (const target of targets) {
      const targetPrefix = stripWildcard(target)
      const vocabulary = vocabularyFor(targetPrefix)
      if (vocabulary === null) continue

      rules.push({
        match: { pathPrefix: `${targetPrefix}/` },
        kind: vocabulary.kind,
        traversable: vocabulary.traversable,
        screenEntry: vocabulary.screenEntry,
        priority: ALIAS_PRIORITY,
      })
    }
  }

  const sourceRoots = options.sourceRootsRel ?? ["src"]
  for (const root of sourceRoots) {
    const prefix = root === "." || root === "" ? "" : `${root}/`

    for (const shared of SHARED_FAMILY)
      for (const sharedName of shared.names)
        for (const entry of TRAVERSABLE_FAMILY)
          for (const name of entry.names)
            rules.push({
              match: { pathPrefix: `${prefix}${sharedName}/${name}/` },
              kind: entry.kind,
              traversable: entry.traversable,
              screenEntry: entry.screenEntry,
              priority: NESTED_PRIORITY,
            })

    for (const entry of DIRECTORY_VOCABULARY) {
      for (const name of entry.names) {
        rules.push({
          match: { pathPrefix: `${prefix}${name}/` },
          kind: entry.kind,
          traversable: entry.traversable,
          screenEntry: entry.screenEntry,
          priority: VOCABULARY_PRIORITY,
        })
      }
    }
  }

  rules.push({ match: {}, kind: DEFAULT_KIND, traversable: false, screenEntry: false, priority: DEFAULT_PRIORITY })

  return rules
}
