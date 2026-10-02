import { useCallback, useRef } from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { Virtualizer } from "@tanstack/react-virtual"
import { ChevronRight, EyeOff, Server } from "lucide-react"
import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import { EmptyState } from "@/components/EmptyState"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FilterInput } from "@/components/FilterInput"
import { Kbd } from "@/components/ui/kbd"
import { useI18n } from "@/app/report-context"
import { SCREEN_LIST_SLOT, screenListMoveRef } from "@/hotkeys/screen-list-bus"
import type { ScreenListDirection } from "@/hotkeys/screen-list-bus"
import { searchInputRef } from "@/hotkeys/search-registry"
import { cn } from "@/lib/utils"
import { SELECTION_HIDDEN_KEY } from "./keys"
import { nextScreenId, rowIndexOf } from "./list-model"
import type { ApiGroupRow, ListRow, ScreenRow } from "./list-model"
import { ScreenBadges } from "./ScreenBadges"
import { useScreenFilter } from "./useScreenFilter"

const ROW_ESTIMATE_PX = 76
const GROUP_ROW_ESTIMATE_PX = 44
const OVERSCAN = 8

const screensSearchRef = searchInputRef("screens")

const estimateRow = (row: ListRow | undefined) => (row?.type === "apiGroup" ? GROUP_ROW_ESTIMATE_PX : ROW_ESTIMATE_PX)

const useScrollToIndexRef = (virtualizer: Virtualizer<HTMLDivElement, Element>, index: number) =>
  useCallback(
    (element: HTMLElement | null) => {
      if (element === null || index < 0) return
      virtualizer.scrollToIndex(index, { align: "auto" })
    },
    [virtualizer, index],
  )

type ScreenListProps = {
  readonly screens: readonly ScreenPayload[]
  readonly selectedId: string | null
  readonly onSelect: (id: string) => void
  readonly onMove: (id: string) => void
}

type ScreenRowButtonProps = {
  readonly row: ScreenRow
  readonly selected: boolean
  readonly onSelect: (id: string) => void
  readonly focusRef: (id: string) => (element: HTMLButtonElement | null) => void
}

const ScreenRowButton = ({ row, selected, onSelect, focusRef }: ScreenRowButtonProps) => {
  const { screen } = row
  return (
    <button
      type="button"
      ref={focusRef(screen.id)}
      data-screen-id={screen.id}
      aria-current={selected ? "true" : undefined}
      onClick={() => onSelect(screen.id)}
      className={cn(
        "group/row relative flex w-full pointer-coarse:min-h-11 flex-col items-start gap-1 rounded-lg px-3 py-2.5 text-start outline-none transition-colors hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50",
        selected && "bg-muted before:absolute before:inset-y-2 before:left-0 before:w-1 before:rounded-full before:bg-foreground",
        screen.isApi && "ps-6",
      )}
    >
      <span className="w-full truncate font-mono text-[13px] font-semibold text-foreground">{screen.primaryLabel}</span>
      <span className="w-full truncate text-xs text-muted-foreground">{screen.title ?? screen.localId}</span>
      <ScreenBadges screen={screen} />
    </button>
  )
}

type ApiGroupButtonProps = {
  readonly row: ApiGroupRow
  readonly onToggle: () => void
}

const ApiGroupButton = ({ row, onToggle }: ApiGroupButtonProps) => {
  const { t } = useI18n()
  return (
    <button
      type="button"
      data-slot="api-group-toggle"
      aria-expanded={row.open}
      onClick={onToggle}
      className="mt-1 flex w-full items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-start text-sm font-medium outline-none hover:bg-muted/70 focus-visible:ring-3 focus-visible:ring-ring/50 pointer-coarse:min-h-11"
    >
      <ChevronRight aria-hidden className={cn("size-4 transition-transform", row.open && "rotate-90")} />
      <Server aria-hidden className="size-4 text-muted-foreground" />
      <span className="flex-1">{t("screenListApiGroup")}</span>
      <Badge variant="secondary" className="tabular-nums">
        {row.count}
      </Badge>
    </button>
  )
}

type HiddenSelectionNoticeProps = {
  readonly label: string
  readonly onClear: () => void
}

const HiddenSelectionNotice = ({ label, onClear }: HiddenSelectionNoticeProps) => {
  const { t } = useI18n()
  return (
    <div
      data-slot="selection-hidden"
      className="flex items-center gap-2 rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
    >
      <EyeOff aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{t(SELECTION_HIDDEN_KEY, { label })}</span>
      <Button type="button" variant="ghost" size="xs" onClick={onClear} className="pointer-coarse:h-11">
        {t("filterClear")}
      </Button>
    </div>
  )
}

export const ScreenList = ({ screens, selectedId, onSelect, onMove }: ScreenListProps) => {
  const { t, tPlural } = useI18n()
  const selected = screens.find((screen) => screen.id === selectedId) ?? null
  const filter = useScreenFilter(screens, selectedId, selected?.isApi ?? false)
  const { rows } = filter.model
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const pendingFocus = useRef<string | null>(null)
  const selectedIndex = rowIndexOf(rows, selectedId)

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimateRow(rows[index]),
    getItemKey: (index) => rows[index]?.key ?? index,
    initialOffset: Math.max(selectedIndex - 2, 0) * ROW_ESTIMATE_PX,
    overscan: OVERSCAN,
  })

  const revealSelectionRef = useScrollToIndexRef(virtualizer, selectedIndex)

  const focusRef = (id: string) => (element: HTMLButtonElement | null) => {
    if (element === null || pendingFocus.current !== id) return
    pendingFocus.current = null
    element.focus()
  }

  const handleMove = (direction: ScreenListDirection) => {
    const target = nextScreenId(rows, selectedId, direction)
    if (target === null) return
    const listHasFocus = scrollRef.current?.contains(document.activeElement) ?? false
    pendingFocus.current = listHasFocus ? target : null
    onMove(target)
  }

  const setInputRef = (element: HTMLInputElement | null) => {
    inputRef.current = element
    screensSearchRef(element)
  }

  const clearFilter = () => {
    filter.clearQuery()
    inputRef.current?.focus()
  }

  const selectionHidden = selected !== null && filter.isFiltering && rowIndexOf(rows, selected.id) === -1
  const showEmpty = filter.isFiltering && filter.model.matchCount === 0

  return (
    <div ref={screenListMoveRef(handleMove)} data-slot={SCREEN_LIST_SLOT} className="flex min-w-0 flex-col gap-3">
      <FilterInput
        label={t("screenFilterLabel")}
        placeholder={t("screenFilterExample")}
        value={filter.query}
        onValueChange={filter.setQuery}
        inputRef={setInputRef}
        hint={<Kbd aria-hidden>/</Kbd>}
      />
      <p aria-live="polite" aria-atomic="true" className="text-xs text-muted-foreground tabular-nums">
        {tPlural("screenListCount", filter.model.matchCount)}
      </p>
      {selectionHidden && !showEmpty && <HiddenSelectionNotice label={selected.primaryLabel} onClear={clearFilter} />}
      {showEmpty ? (
        <EmptyState
          title={t("screenFilterEmpty", { query: filter.query.trim() })}
          onClear={clearFilter}
          className="p-6"
        />
      ) : (
        <div
          ref={scrollRef}
          className="h-[min(45dvh,24rem)] overflow-y-auto overscroll-contain rounded-xl border bg-card p-1.5 lg:h-[min(70dvh,46rem)]"
        >
          <ul ref={revealSelectionRef} aria-label={t("screenListLabel")} className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index]
              if (row === undefined) return null
              return (
                <li
                  key={item.key}
                  data-index={item.index}
                  ref={virtualizer.measureElement}
                  className="absolute inset-x-0 top-0 pb-0.5"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  {row.type === "apiGroup" ? (
                    <ApiGroupButton row={row} onToggle={filter.toggleApiGroup} />
                  ) : (
                    <ScreenRowButton
                      row={row}
                      selected={row.screen.id === selectedId}
                      onSelect={onSelect}
                      focusRef={focusRef}
                    />
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      )}
    </div>
  )
}
