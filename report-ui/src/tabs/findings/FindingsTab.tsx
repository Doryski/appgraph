import type { ComponentType } from "react"
import { FINDING_SECTIONS } from "@appgraph/emit/report-derive.js"
import type { FindingSectionId } from "@appgraph/emit/report-derive.js"
import { ConfidenceSection } from "./ConfidenceSection"
import { DeadLinksSection } from "./DeadLinksSection"
import { DiagnosticsSection } from "./DiagnosticsSection"
import { EmptyResultAlert } from "./EmptyResultAlert"
import { LimitationsAlert } from "./LimitationsAlert"
import { OrphansSection } from "./OrphansSection"

const SECTION_COMPONENTS = {
  limitations: LimitationsAlert,
  "dead-links": DeadLinksSection,
  orphans: OrphansSection,
  confidence: ConfidenceSection,
  diagnostics: DiagnosticsSection,
} as const satisfies Record<FindingSectionId, ComponentType>

export const FindingsTab = () => (
  <div data-slot="findings-tab" className="mx-auto flex w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
    <EmptyResultAlert />
    {FINDING_SECTIONS.map((id) => {
      const Section = SECTION_COMPONENTS[id]
      return <Section key={id} />
    })}
  </div>
)
