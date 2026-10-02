import type { ReactNode } from "react"
import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import type { StringKey } from "@appgraph/emit/strings.js"
import type { GlossaryTermId } from "@/config/glossary"
import type { I18n } from "@/lib/i18n"
import { ActivationList } from "./ActivationList"
import { AncestorList } from "./AncestorList"
import { ChipList } from "./ChipList"
import { EndpointsTable } from "./EndpointsTable"
import { NavChips } from "./NavChips"
import { RenderTree } from "./RenderTree"
import { ShellSection } from "./ShellSection"
import type { ShellPayload } from "./ShellSection"

type ChipField = "stores" | "queryKeys" | "i18nNamespaces" | "featureGates" | "formSchemas" | "formFields" | "testIds" | "messages"

type SectionEntry = {
  readonly id: string
  readonly titleKey: StringKey
  readonly term: GlossaryTermId | null
  readonly emptyKey: StringKey
} & (
  | { readonly body: "activation" | "tree" | "nav" | "ancestors" | "shell" | "endpoints" | "extra" | "params" | "reach" }
  | { readonly body: "chips"; readonly field: ChipField; readonly copyable: boolean }
)

export const DETAIL_SECTIONS = [
  { id: "activation", titleKey: "sectionActivation", term: "activation", emptyKey: "emptyGeneric", body: "activation" },
  { id: "renderTree", titleKey: "sectionRenderTree", term: "renderTree", emptyKey: "emptyGeneric", body: "tree" },
  { id: "navigation", titleKey: "sectionOutgoingNav", term: "navEdges", emptyKey: "emptyNav", body: "nav" },
  { id: "ancestors", titleKey: "sectionAncestors", term: "ancestors", emptyKey: "emptyAncestors", body: "ancestors" },
  { id: "shell", titleKey: "sectionShell", term: "shell", emptyKey: "emptyShell", body: "shell" },
  { id: "endpoints", titleKey: "sectionEndpoints", term: "endpoints", emptyKey: "emptyEndpoints", body: "endpoints" },
  {
    id: "stores",
    titleKey: "sectionStores",
    term: "stores",
    emptyKey: "emptyGeneric",
    body: "chips",
    field: "stores",
    copyable: false,
  },
  {
    id: "queryKeys",
    titleKey: "sectionQueryKeys",
    term: "queryKeys",
    emptyKey: "emptyGeneric",
    body: "chips",
    field: "queryKeys",
    copyable: true,
  },
  {
    id: "i18n",
    titleKey: "sectionI18n",
    term: "i18n",
    emptyKey: "emptyGeneric",
    body: "chips",
    field: "i18nNamespaces",
    copyable: false,
  },
  {
    id: "featureGates",
    titleKey: "sectionFeatureGates",
    term: "featureGates",
    emptyKey: "emptyGeneric",
    body: "chips",
    field: "featureGates",
    copyable: false,
  },
  {
    id: "formSchemas",
    titleKey: "sectionFormSchemas",
    term: "formSchemas",
    emptyKey: "emptyGeneric",
    body: "chips",
    field: "formSchemas",
    copyable: false,
  },
  {
    id: "formFields",
    titleKey: "sectionFormFields",
    term: "formFields",
    emptyKey: "emptyGeneric",
    body: "chips",
    field: "formFields",
    copyable: false,
  },
  {
    id: "testIds",
    titleKey: "sectionTestIds",
    term: "testIds",
    emptyKey: "emptyGeneric",
    body: "chips",
    field: "testIds",
    copyable: true,
  },
  {
    id: "messages",
    titleKey: "sectionMessages",
    term: "messages",
    emptyKey: "emptyGeneric",
    body: "chips",
    field: "messages",
    copyable: false,
  },
  { id: "extra", titleKey: "sectionExtraChannel", term: null, emptyKey: "emptyGeneric", body: "extra" },
  { id: "params", titleKey: "sectionParams", term: null, emptyKey: "emptyGeneric", body: "params" },
  { id: "reach", titleKey: "sectionReachTitle", term: "reach", emptyKey: "emptyGeneric", body: "reach" },
] as const satisfies readonly SectionEntry[]

type DetailSectionEntry = (typeof DETAIL_SECTIONS)[number]

export type SectionModel = {
  readonly key: string
  readonly title: string
  readonly term: GlossaryTermId | null
  readonly isEmpty: boolean
  readonly emptyText: string
  readonly content: ReactNode
}

type SectionContext = {
  readonly screen: ScreenPayload
  readonly shell: ShellPayload | null
  readonly i18n: I18n
}

type Body = {
  readonly isEmpty: boolean
  readonly content: ReactNode
}

const body = (isEmpty: boolean, content: () => ReactNode): Body => ({ isEmpty, content: isEmpty ? null : content() })

const shellBody = (shell: ShellPayload | null): Body => {
  if (shell === null) return { isEmpty: true, content: null }
  return { isEmpty: false, content: <ShellSection shell={shell} /> }
}

const sectionBody = (entry: Exclude<DetailSectionEntry, { readonly body: "extra" }>, context: SectionContext): Body => {
  const { screen, shell, i18n } = context
  switch (entry.body) {
    case "activation":
      return body(screen.activations.length === 0, () => <ActivationList activations={screen.activations} />)
    case "tree":
      return body(screen.tree.length === 0, () => <RenderTree nodes={screen.tree} />)
    case "nav":
      return body(screen.navChips.length === 0, () => <NavChips chips={screen.navChips} />)
    case "ancestors":
      return body(screen.ancestors.length === 0, () => <AncestorList ancestors={screen.ancestors} />)
    case "shell":
      return shellBody(shell)
    case "endpoints":
      return body(screen.facts.endpoints.length === 0, () => <EndpointsTable endpoints={screen.facts.endpoints} />)
    case "chips": {
      const values = screen.facts[entry.field]
      return body(values.length === 0, () => <ChipList values={values} copyable={entry.copyable} />)
    }
    case "params":
      return body(screen.params.length === 0, () => <ChipList values={screen.params} />)
    case "reach":
      return body(screen.reachableCount === 0, () => (
        <p className="text-sm">
          <span className="font-semibold tabular-nums">{i18n.tPlural("sectionReach", screen.reachableCount)}</span>
        </p>
      ))
  }
}

const extraSections = (entry: Extract<DetailSectionEntry, { readonly body: "extra" }>, context: SectionContext) =>
  context.screen.facts.extra.map(({ channel, values }): SectionModel => ({
    key: `${entry.id}:${channel}`,
    title: context.i18n.t(entry.titleKey, { channel }),
    term: entry.term,
    emptyText: context.i18n.t(entry.emptyKey),
    ...body(values.length === 0, () => <ChipList values={values} />),
  }))

const toSectionModels = (entry: DetailSectionEntry, context: SectionContext): readonly SectionModel[] => {
  if (entry.body === "extra") return extraSections(entry, context)
  return [
    {
      key: entry.id,
      title: context.i18n.t(entry.titleKey),
      term: entry.term,
      emptyText: context.i18n.t(entry.emptyKey),
      ...sectionBody(entry, context),
    },
  ]
}

export const buildSections = (context: SectionContext): readonly SectionModel[] =>
  DETAIL_SECTIONS.flatMap((entry) => toSectionModels(entry, context))
