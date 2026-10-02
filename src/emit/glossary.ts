import type { StringKey } from "./strings.js"

type GlossaryEntry = {
  readonly id: string
  readonly labelKey: StringKey
  readonly helpKey: StringKey
}

export const GLOSSARY = [
  { id: "screens", labelKey: "tabScreens", helpKey: "helpScreens" },
  { id: "apiRoutes", labelKey: "countApiRoutes", helpKey: "helpApiRoutes" },
  { id: "components", labelKey: "tabComponents", helpKey: "helpComponents" },
  { id: "kind", labelKey: "colKind", helpKey: "helpKind" },
  { id: "renderTree", labelKey: "sectionRenderTree", helpKey: "helpRenderTree" },
  { id: "renderEdges", labelKey: "countRenderEdges", helpKey: "helpRenderEdges" },
  { id: "depth", labelKey: "countDepth", helpKey: "helpDepth" },
  { id: "navEdges", labelKey: "countNavEdges", helpKey: "helpNavEdges" },
  { id: "redirects", labelKey: "countRedirects", helpKey: "helpRedirects" },
  { id: "deadLinks", labelKey: "countDeadLinks", helpKey: "helpDeadLinks" },
  { id: "orphans", labelKey: "findingsOrphansTitle", helpKey: "helpOrphans" },
  { id: "confidence", labelKey: "findingsConfidenceTitle", helpKey: "helpConfidence" },
  { id: "ancestors", labelKey: "sectionAncestors", helpKey: "helpAncestors" },
  { id: "splice", labelKey: "glossaryTermSplice", helpKey: "helpSplice" },
  { id: "shell", labelKey: "sectionShell", helpKey: "helpShell" },
  { id: "reach", labelKey: "sectionReachTitle", helpKey: "helpReach" },
  { id: "activation", labelKey: "sectionActivation", helpKey: "helpActivation" },
  { id: "auth", labelKey: "badgeAuthProtected", helpKey: "helpAuth" },
  { id: "endpoints", labelKey: "countEndpoints", helpKey: "helpEndpoints" },
  { id: "transport", labelKey: "glossaryTermTransport", helpKey: "helpTransport" },
  { id: "stores", labelKey: "sectionStores", helpKey: "helpStores" },
  { id: "queryKeys", labelKey: "sectionQueryKeys", helpKey: "helpQueryKeys" },
  { id: "i18n", labelKey: "sectionI18n", helpKey: "helpI18n" },
  { id: "featureGates", labelKey: "sectionFeatureGates", helpKey: "helpFeatureGates" },
  { id: "formSchemas", labelKey: "sectionFormSchemas", helpKey: "helpFormSchemas" },
  { id: "formFields", labelKey: "sectionFormFields", helpKey: "helpFormFields" },
  { id: "testIds", labelKey: "sectionTestIds", helpKey: "helpTestIds" },
  { id: "messages", labelKey: "sectionMessages", helpKey: "helpMessages" },
  { id: "condOnly", labelKey: "glossaryTermCondOnly", helpKey: "helpCondOnly" },
  { id: "condSometimes", labelKey: "glossaryTermCondSometimes", helpKey: "helpCondSometimes" },
  { id: "guard", labelKey: "glossaryTermGuard", helpKey: "helpGuard" },
  { id: "repeated", labelKey: "treeRepeatedLabel", helpKey: "helpRepeated" },
] as const satisfies readonly GlossaryEntry[]

export type GlossaryTerm = (typeof GLOSSARY)[number]

export type GlossaryTermId = GlossaryTerm["id"]

const GLOSSARY_BY_ID: ReadonlyMap<GlossaryTermId, GlossaryTerm> = new Map(GLOSSARY.map((term) => [term.id, term]))

export const glossaryTerm = (id: GlossaryTermId): GlossaryTerm | undefined => GLOSSARY_BY_ID.get(id)
