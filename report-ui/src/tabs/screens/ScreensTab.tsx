import { useMemo, useRef } from "react"
import type { ComponentType } from "react"
import { LayoutList } from "lucide-react"
import { EmptyState } from "@/components/EmptyState"
import { useI18n, usePayload } from "@/app/report-context"
import type { TabPanelProps } from "@/app/panels"
import { resolveScreen, selectScreen, useUrlState } from "@/lib/url-state"
import { ScreenDetail } from "./detail/ScreenDetail"
import { defaultScreenId } from "./list-model"
import { ScreenList } from "./ScreenList"

const STACKED_LAYOUT_QUERY = "(max-width: 1023.98px)"

const isStackedLayout = () => window.matchMedia(STACKED_LAYOUT_QUERY).matches

export const ScreensTab: ComponentType<TabPanelProps> = () => {
  const { t } = useI18n()
  const { screens } = usePayload()
  const urlState = useUrlState()
  const detailRef = useRef<HTMLDivElement>(null)
  const screenIds = useMemo(() => new Set(screens.map((screen) => screen.id)), [screens])
  const fallbackId = useMemo(() => defaultScreenId(screens), [screens])
  const selectedId = resolveScreen(urlState, screenIds, fallbackId).id
  const selected = screens.find((screen) => screen.id === selectedId) ?? null

  const handleSelect = (id: string) => {
    selectScreen(id, "push")
    if (isStackedLayout()) detailRef.current?.scrollIntoView({ block: "start" })
  }

  const handleMove = (id: string) => selectScreen(id, "replace")

  if (screens.length === 0) return <EmptyState icon={LayoutList} title={t("screenDetailEmpty")} />

  return (
    <div data-slot="screens-tab" className="grid gap-5 lg:grid-cols-[20rem_minmax(0,1fr)] lg:items-start">
      <aside className="min-w-0 lg:sticky lg:top-0">
        <ScreenList screens={screens} selectedId={selectedId} onSelect={handleSelect} onMove={handleMove} />
      </aside>
      <div ref={detailRef} className="min-w-0 scroll-mt-4">
        {selected && <ScreenDetail key={selected.id} screen={selected} />}
      </div>
    </div>
  )
}
