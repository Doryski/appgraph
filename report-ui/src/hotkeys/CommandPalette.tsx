import { useDeferredValue, useMemo, useState } from "react"
import type { ReactNode } from "react"
import { Boxes, Keyboard, LayoutList } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import {
  PALETTE_GROUP_LIMIT,
  componentPaletteText,
  joinSearchText,
  matchesTokens,
  queryTokens,
  screenPaletteText,
} from "@appgraph/emit/report-derive.js"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command"
import { useI18n, usePayload } from "@/app/report-context"
import type { Translate } from "@/lib/i18n"
import { TABS } from "@/config/tabs"
import type { TabId } from "@/config/tabs"
import { HOTKEYS, isSequenceEntry } from "@/hotkeys/config"
import { KeyList } from "@/hotkeys/KeyCombo"
import { setTabQuery } from "@/lib/tab-query"
import { selectScreen, setTab } from "@/lib/url-state"

type PaletteItem = {
  readonly value: string
  readonly label: string
  readonly detail: string | null
  readonly haystack: string
  readonly icon: LucideIcon
  readonly hint: ReactNode
  readonly run: () => void
}

const matchingItems = (items: readonly PaletteItem[], tokens: readonly string[]) =>
  items.filter((item) => matchesTokens(item.haystack, tokens))

const showComponent = (file: string) => {
  setTabQuery("components", file)
  setTab("components")
}

const tabSequence = (tab: TabId) => HOTKEYS.filter(isSequenceEntry).find((entry) => entry.tab === tab)?.sequence

const buildDataGroups = (t: Translate, payload: ReturnType<typeof usePayload>) => {
  const thenLabel = t("shortcutThen")
  const tabs = TABS.map((tab) => {
    const sequence = tabSequence(tab.id)
    return {
      value: `tab:${tab.id}`,
      label: t(tab.labelKey),
      detail: null,
      haystack: joinSearchText(t(tab.labelKey), t(tab.descriptionKey)),
      icon: tab.icon,
      hint: sequence === undefined ? null : <KeyList keys={sequence} separator={thenLabel} />,
      run: () => setTab(tab.id),
    }
  })
  const screens = payload.screens.map((screen) => ({
    value: `screen:${screen.id}`,
    label: screen.primaryLabel,
    detail: screen.title,
    haystack: screenPaletteText(screen),
    icon: LayoutList,
    hint: null,
    run: () => selectScreen(screen.id, "push"),
  }))
  const components = payload.components.map((component) => ({
    value: `component:${component.file}#${component.component}`,
    label: component.component,
    detail: component.route ?? component.file,
    haystack: componentPaletteText(component),
    icon: Boxes,
    hint: null,
    run: () => showComponent(component.file),
  }))
  return [
    { id: "tabs", heading: t("paletteGroupTabs"), items: tabs },
    { id: "screens", heading: t("paletteGroupScreens"), items: screens },
    { id: "components", heading: t("tabComponents"), items: components },
  ] as const
}

const buildActionGroup = (t: Translate, openShortcuts: () => void) => ({
  id: "actions",
  heading: t("paletteGroupActions"),
  items: [
    {
      value: "action:shortcuts",
      label: t("shortcutsOpen"),
      detail: null,
      haystack: joinSearchText(t("shortcutsOpen"), t("shortcutHelp")),
      icon: Keyboard,
      hint: <KeyList keys={["?"]} separator="" />,
      run: openShortcuts,
    },
  ],
})

const PaletteRow = ({ item, onRun }: { readonly item: PaletteItem; readonly onRun: (item: PaletteItem) => void }) => {
  const Icon = item.icon
  return (
    <CommandItem value={item.value} onSelect={() => onRun(item)} className="min-h-10 gap-3 pointer-coarse:min-h-11">
      <Icon aria-hidden className="text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{item.label}</span>
        {item.detail !== null && item.detail !== "" && (
          <span className="truncate font-mono text-xs text-muted-foreground">{item.detail}</span>
        )}
      </span>
      {item.hint !== null && <CommandShortcut className="tracking-normal">{item.hint}</CommandShortcut>}
    </CommandItem>
  )
}

type PaletteBodyProps = {
  readonly onClose: () => void
  readonly onOpenShortcuts: () => void
}

const PaletteBody = ({ onClose, onOpenShortcuts }: PaletteBodyProps) => {
  const { t } = useI18n()
  const payload = usePayload()
  const [query, setQuery] = useState("")
  const deferredQuery = useDeferredValue(query)
  const dataGroups = useMemo(() => buildDataGroups(t, payload), [t, payload])
  const groups = [...dataGroups, buildActionGroup(t, onOpenShortcuts)]
  const tokens = queryTokens(deferredQuery)
  const matching = groups
    .map((group) => ({ ...group, items: matchingItems(group.items, tokens) }))
    .filter((group) => group.items.length > 0)
  const capped = matching.some((group) => group.items.length > PALETTE_GROUP_LIMIT)
  const visible = matching.map((group) => ({ ...group, items: group.items.slice(0, PALETTE_GROUP_LIMIT) }))
  const run = (item: PaletteItem) => {
    onClose()
    item.run()
  }
  return (
    <Command shouldFilter={false} loop label={t("paletteOpen")}>
      <CommandInput value={query} onValueChange={setQuery} placeholder={t("palettePlaceholder")} aria-label={t("palettePlaceholder")} />
      <CommandList label={t("paletteResults")} className="max-h-[min(26rem,60dvh)]">
        <CommandEmpty>{t("paletteEmpty")}</CommandEmpty>
        {visible.map((group) => (
          <CommandGroup
            key={group.id}
            heading={group.heading}
            data-palette-group={group.id}
            className="not-first:border-t not-first:border-border"
          >
            {group.items.map((item) => (
              <PaletteRow key={item.value} item={item} onRun={run} />
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      {capped && <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{t("paletteKeepTyping")}</p>}
    </Command>
  )
}

type CommandPaletteProps = {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onOpenShortcuts: () => void
}

export const CommandPalette = ({ open, onOpenChange, onOpenShortcuts }: CommandPaletteProps) => {
  const { t } = useI18n()
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("paletteOpen")}
      description={t("palettePlaceholder")}
      className="sm:max-w-xl"
    >
      <PaletteBody onClose={() => onOpenChange(false)} onOpenShortcuts={onOpenShortcuts} />
    </CommandDialog>
  )
}
