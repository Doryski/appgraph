import { useState } from "react"
import type { MouseEvent } from "react"
import { Toaster } from "@/components/ui/sonner"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { TooltipProvider } from "@/components/ui/tooltip"
import { EmptyReport } from "@/app/EmptyReport"
import { Header } from "@/app/Header"
import { TAB_PANELS, TABS_WITHOUT_EMPTY_REPORT } from "@/app/panels"
import { useI18n, usePayload } from "@/app/report-context"
import { TabNav } from "@/app/TabNav"
import { useVisitedTabs } from "@/app/useVisitedTabs"
import { TABS, isTabId } from "@/config/tabs"
import type { Tab } from "@/config/tabs"
import { CommandPalette } from "@/hotkeys/CommandPalette"
import { ShortcutsDialog } from "@/hotkeys/ShortcutsDialog"
import { useAppHotkeys } from "@/hotkeys/useAppHotkeys"
import { setTab, useUrlState } from "@/lib/url-state"

export const MAIN_CONTENT_ID = "main-content"

const BOTTOM_BAR_TOAST_OFFSET = { bottom: 88 } as const

const changeTab = (value: unknown) => {
  if (typeof value === "string" && isTabId(value)) setTab(value)
}

const skipToContent = (event: MouseEvent<HTMLAnchorElement>) => {
  event.preventDefault()
  document.getElementById(MAIN_CONTENT_ID)?.focus()
}

const PanelBody = ({ tab, emptyResult }: { readonly tab: Tab; readonly emptyResult: boolean }) => {
  if (emptyResult && !TABS_WITHOUT_EMPTY_REPORT.has(tab.id)) return <EmptyReport />
  const Panel = TAB_PANELS[tab.id]
  return <Panel tab={tab} />
}

type OpenDialog = "shortcuts" | "palette" | null

export const App = () => {
  const { t } = useI18n()
  const { meta } = usePayload()
  const { tab } = useUrlState()
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const visited = useVisitedTabs(tab)
  const openShortcuts = () => setDialog("shortcuts")
  const openPalette = () => setDialog("palette")
  const closeOn = (id: Exclude<OpenDialog, null>) => (open: boolean) => setDialog(open ? id : null)
  useAppHotkeys({ tab, openPalette, openShortcuts })
  return (
    <TooltipProvider>
      <Tabs value={tab} onValueChange={changeTab} className="h-dvh gap-0 overflow-hidden bg-background text-foreground">
        <a
          href={`#${MAIN_CONTENT_ID}`}
          onClick={skipToContent}
          className="sr-only rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:inline-flex focus:min-h-10 focus:items-center focus:px-4 focus:z-50 focus:outline-none focus:ring-3 focus:ring-ring/50"
        >
          {t("skipToContent")}
        </a>
        <Header onOpenShortcuts={openShortcuts} onOpenPalette={openPalette} />
        <TabNav />
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none">
          {TABS.map((item) => (
            <TabsContent
              key={item.id}
              value={item.id}
              keepMounted
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset"
            >
              <div className="mx-auto w-full max-w-7xl px-4 pt-5 pb-28 md:pb-8 lg:px-6">
                {visited.has(item.id) ? <PanelBody tab={item} emptyResult={meta.emptyResult} /> : null}
              </div>
            </TabsContent>
          ))}
        </main>
      </Tabs>
      <ShortcutsDialog open={dialog === "shortcuts"} onOpenChange={closeOn("shortcuts")} />
      <CommandPalette open={dialog === "palette"} onOpenChange={closeOn("palette")} onOpenShortcuts={openShortcuts} />
      <Toaster containerAriaLabel={t("notificationsRegion")} position="bottom-right" mobileOffset={BOTTOM_BAR_TOAST_OFFSET} />
    </TooltipProvider>
  )
}
