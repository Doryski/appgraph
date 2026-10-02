import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { useI18n } from "@/app/report-context"
import { TABS } from "@/config/tabs"
import type { Tab } from "@/config/tabs"

const TabTrigger = ({ tab, label }: { readonly tab: Tab; readonly label: string }) => {
  const Icon = tab.icon
  return (
    <TabsPrimitive.Tab
      value={tab.id}
      data-slot="tab-nav-trigger"
      className="group/tab relative flex min-h-14 min-w-0 cursor-pointer flex-col items-center justify-center gap-1 px-1 py-1.5 text-center text-xs leading-tight font-medium text-balance text-muted-foreground outline-none transition-colors select-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset data-[active]:text-foreground md:min-h-11 md:flex-row md:gap-2 md:rounded-md md:px-3 md:text-sm md:whitespace-nowrap"
    >
      <span className="flex items-center justify-center rounded-full px-4 py-1 transition-colors group-data-[active]/tab:bg-muted md:p-0 md:group-data-[active]/tab:bg-transparent">
        <Icon aria-hidden className="size-5 md:size-4" />
      </span>
      <span>{label}</span>
    </TabsPrimitive.Tab>
  )
}

export const TabNav = () => {
  const { t } = useI18n()
  return (
    <nav aria-label={t("tabsLabel")} className="shrink-0 md:border-b">
      <div className="mx-auto w-full max-w-7xl md:px-4 lg:px-6">
        <TabsPrimitive.List
          aria-label={t("tabsLabel")}
          data-slot="tab-nav"
          className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_-16px_rgb(0_0_0/0.35)] backdrop-blur md:relative md:inset-auto md:z-auto md:flex md:gap-1 md:border-t-0 md:bg-transparent md:pb-0 md:shadow-none md:backdrop-blur-none"
        >
          {TABS.map((tab) => (
            <TabTrigger key={tab.id} tab={tab} label={t(tab.labelKey)} />
          ))}
          <TabsPrimitive.Indicator className="absolute bottom-[-1px] left-(--active-tab-left) h-0.5 w-(--active-tab-width) rounded-full bg-foreground transition-[left,width] duration-200 ease-out max-md:hidden" />
        </TabsPrimitive.List>
      </div>
    </nav>
  )
}
