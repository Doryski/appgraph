import { ChartNoAxesColumn, Keyboard, Search, ShieldAlert } from "lucide-react"
import { isAlarmingStat, isHiddenStat, statValue } from "@appgraph/emit/report-derive.js"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { CountStat } from "@/components/CountStat"
import { GlossaryDialog } from "@/components/GlossaryDialog"
import { InfoTip, InfoTipLabel } from "@/components/InfoTip"
import { ThemeMenu } from "@/components/ThemeMenu"
import { HEADER_ACTION_CLASS, HEADER_ACTION_LABEL_CLASS } from "@/components/header-action"
import { useI18n, usePayload } from "@/app/report-context"
import { KeyCombo } from "@/hotkeys/KeyCombo"
import { PRIMARY_STATS, SECONDARY_STATS, statNoun } from "@/config/stats"
import { setTab } from "@/lib/url-state"

const openFindings = () => setTab("findings")

const GeneratedAt = ({ value, className }: { readonly value: string; readonly className?: string }) => {
  const { t } = useI18n()
  return (
    <p className={className}>
      <span>{t("generatedAtLabel")}</span> <time dateTime={value} className="font-mono tabular-nums">{value}</time>
    </p>
  )
}

const PrimaryStats = () => {
  const { t, tPlural } = useI18n()
  const { meta } = usePayload()
  return (
    <div data-slot="primary-stats" className="grid grid-cols-2 items-end gap-x-4 gap-y-3 sm:flex sm:flex-wrap sm:gap-x-7">
      {PRIMARY_STATS.map((stat) => {
        const value = statValue(meta, stat.id)
        const countText = stat.pluralKey === null ? undefined : tPlural(stat.pluralKey, value)
        return (
          <CountStat
            key={stat.id}
            id={stat.id}
            label={t(stat.labelKey)}
            countText={countText}
            help={t(stat.helpKey)}
            value={value}
            alarm={isAlarmingStat(stat, value)}
            onActivate={stat.alarm ? openFindings : undefined}
          />
        )
      })}
    </div>
  )
}

const MoreStats = () => {
  const { t, tPlural } = useI18n()
  const { meta } = usePayload()
  const rows = SECONDARY_STATS.map((stat) => ({ stat, value: statValue(meta, stat.id) })).filter(
    ({ stat, value }) => !isHiddenStat(stat, value),
  )
  return (
    <Popover>
      <PopoverTrigger render={<Button type="button" variant="outline" size="sm" className="pointer-coarse:h-11" />}>
        <ChartNoAxesColumn aria-hidden />
        {t("moreStatsLabel")}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 gap-3">
        <PopoverHeader>
          <PopoverTitle>{t("moreStatsTitle")}</PopoverTitle>
        </PopoverHeader>
        <dl data-slot="more-stats" className="flex flex-col divide-y">
          {rows.map(({ stat, value }) => (
            <div key={stat.id} className="flex items-center justify-between gap-3 py-1.5">
              <dt className="text-muted-foreground">
                <InfoTipLabel tip={<InfoTip term={t(stat.labelKey)} help={t(stat.helpKey)} />}>
                  {stat.pluralKey === null ? t(stat.labelKey) : statNoun(tPlural(stat.pluralKey, value), value)}
                </InfoTipLabel>
              </dt>
              <dd className="font-mono font-semibold tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {meta.generatedAt !== null && (
          <GeneratedAt value={meta.generatedAt} className="border-t pt-2 text-xs text-muted-foreground" />
        )}
      </PopoverContent>
    </Popover>
  )
}

const PaletteButton = ({ onOpen }: { readonly onOpen: () => void }) => {
  const { t } = useI18n()
  return (
    <Button
      type="button"
      variant="outline"
      data-slot="palette-trigger"
      aria-keyshortcuts="Meta+K Control+K"
      className="mr-1 h-9 min-w-9 gap-2 px-2 text-muted-foreground hover:text-foreground pointer-coarse:h-11 pointer-coarse:min-w-11 lg:min-w-56 lg:justify-start lg:px-2.5"
      onClick={onOpen}
    >
      <Search aria-hidden />
      <span className="sr-only lg:not-sr-only lg:flex-1 lg:text-left">{t("paletteOpen")}</span>
      <span aria-hidden className="hidden lg:inline-flex">
        <KeyCombo keys="Mod+K" />
      </span>
    </Button>
  )
}

type HeaderProps = {
  readonly onOpenShortcuts: () => void
  readonly onOpenPalette: () => void
}

export const Header = ({ onOpenShortcuts, onOpenPalette }: HeaderProps) => {
  const { t } = useI18n()
  const { meta } = usePayload()
  const appName = meta.appName
  return (
    <header className="relative shrink-0 border-b bg-background bg-[radial-gradient(color-mix(in_oklch,var(--foreground)_9%,transparent)_1px,transparent_1px)] bg-size-[14px_14px] md:border-b-0">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 pt-3 pb-4 md:px-4 lg:px-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="line-clamp-2 text-base leading-snug font-semibold tracking-tight text-balance md:text-lg">
              {t("headerTitle", { appName })}
            </h1>
            {meta.generatedAt !== null && (
              <GeneratedAt value={meta.generatedAt} className="hidden text-xs text-muted-foreground sm:block" />
            )}
          </div>
          <div className="-mr-2 flex shrink-0 items-center gap-0.5">
            <PaletteButton onOpen={onOpenPalette} />
            {meta.limitations.length > 0 && (
              <Button type="button" variant="ghost" className={HEADER_ACTION_CLASS} onClick={openFindings}>
                <ShieldAlert aria-hidden />
                <span className={HEADER_ACTION_LABEL_CLASS}>{t("limitationsLink")}</span>
              </Button>
            )}
            <GlossaryDialog />
            <Button
              type="button"
              variant="ghost"
              aria-keyshortcuts="?"
              className={HEADER_ACTION_CLASS}
              onClick={onOpenShortcuts}
            >
              <Keyboard aria-hidden />
              <span className={HEADER_ACTION_LABEL_CLASS}>{t("shortcutsOpen")}</span>
            </Button>
            <ThemeMenu />
          </div>
        </div>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <PrimaryStats />
          <MoreStats />
        </div>
      </div>
    </header>
  )
}
