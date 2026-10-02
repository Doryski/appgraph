import { useId, useMemo } from "react"
import type { ReactNode } from "react"
import { ArrowRight, ChevronRight, Signpost } from "lucide-react"
import { resolveRedirectTarget } from "@appgraph/emit/report-derive.js"
import type { ScreenPayload } from "@appgraph/emit/report-payload.js"
import { CopyButton } from "@/components/CopyButton"
import { GlossaryTip, InfoTipLabel } from "@/components/InfoTip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type { GlossaryTermId } from "@/config/glossary"
import { useI18n, usePayload } from "@/app/report-context"
import { selectScreen } from "@/lib/url-state"
import { SHOW_EMPTY_SECTIONS_KEY } from "../keys"
import { ScreenBadges } from "../ScreenBadges"
import { FilePath } from "./FilePath"
import { buildSections } from "./sections"
import type { SectionModel } from "./sections"

type SectionFrameProps = {
  readonly sectionKey: string
  readonly title: string
  readonly term: GlossaryTermId | null
  readonly children: ReactNode
}

const SectionFrame = ({ sectionKey, title, term, children }: SectionFrameProps) => {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      data-section={sectionKey}
      className="grid gap-2 border-t px-4 py-4 md:px-6 xl:grid-cols-[13rem_minmax(0,1fr)] xl:gap-6"
    >
      <InfoTipLabel className="pt-0.5" tip={term && <GlossaryTip id={term} />}>
        <h3 id={headingId} className="text-sm font-semibold tracking-tight break-words">
          {title}
        </h3>
      </InfoTipLabel>
      <div className="min-w-0">{children}</div>
    </section>
  )
}

const RouteNameBadge = ({ routeName }: { readonly routeName: string }) => {
  const { t } = useI18n()
  return (
    <Badge variant="outline" data-badge="routeName" className="max-w-full">
      <Signpost aria-hidden />
      <span className="text-muted-foreground">{t("routeNameLabel")}</span>
      <span className="truncate font-mono">{routeName}</span>
    </Badge>
  )
}

const DetailHeader = ({ screen, headingId }: { readonly screen: ScreenPayload; readonly headingId: string }) => {
  const file = screen.entries[0]?.file ?? null
  return (
    <header className="flex flex-col gap-2 px-4 pt-5 pb-4 md:px-6">
      <div className="flex min-w-0 items-start gap-1">
        <h2 id={headingId} className="min-w-0 font-mono text-lg leading-snug font-semibold tracking-tight break-all md:text-xl">
          {screen.primaryLabel}
        </h2>
        <CopyButton value={screen.primaryLabel} what={screen.primaryLabel} className="mt-1 shrink-0" />
      </div>
      <p className="text-sm text-muted-foreground">{screen.title ?? screen.localId}</p>
      <span className="flex flex-wrap items-center gap-1">
        <ScreenBadges screen={screen} withGlossary />
        {screen.routeName !== undefined && <RouteNameBadge routeName={screen.routeName} />}
      </span>
      {file !== null && <FilePath file={file} />}
    </header>
  )
}

const RedirectTarget = ({ target }: { readonly target: string }) => {
  const { screens } = usePayload()
  const match = resolveRedirectTarget(screens, target)
  if (match === undefined) return <span className="font-mono text-sm">{target}</span>
  return (
    <Button
      type="button"
      variant="outline"
      data-goto={match.id}
      onClick={() => selectScreen(match.id, "push")}
      className="font-mono pointer-coarse:h-11"
    >
      <ArrowRight aria-hidden />
      {target}
    </Button>
  )
}

const EmptySections = ({ sections }: { readonly sections: readonly SectionModel[] }) => {
  const { t } = useI18n()
  if (sections.length === 0) return null
  return (
    <Collapsible data-slot="empty-sections" className="border-t">
      <CollapsibleTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            className="group/empty h-auto w-full justify-start gap-2 rounded-none px-4 py-3 text-start whitespace-normal text-muted-foreground md:px-6 pointer-coarse:min-h-11"
          />
        }
      >
        <ChevronRight aria-hidden className="transition-transform group-aria-expanded/empty:rotate-90" />
        <span data-slot="empty-count" className="font-medium text-foreground tabular-nums">
          {t(SHOW_EMPTY_SECTIONS_KEY, { count: sections.length })}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs">{sections.map((section) => section.title).join(", ")}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        {sections.map((section) => (
          <SectionFrame key={section.key} sectionKey={section.key} title={section.title} term={section.term}>
            <p className="text-sm text-muted-foreground italic">{section.emptyText}</p>
          </SectionFrame>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
}

const DetailSections = ({ screen }: { readonly screen: ScreenPayload }) => {
  const i18n = useI18n()
  const { shells } = usePayload()
  const shell = useMemo(() => shells.find((entry) => entry.id === screen.shell) ?? null, [shells, screen.shell])
  const sections = useMemo(() => buildSections({ screen, shell, i18n }), [screen, shell, i18n])
  return (
    <>
      {sections
        .filter((section) => !section.isEmpty)
        .map((section) => (
          <SectionFrame key={section.key} sectionKey={section.key} title={section.title} term={section.term}>
            {section.content}
          </SectionFrame>
        ))}
      <EmptySections sections={sections.filter((section) => section.isEmpty)} />
    </>
  )
}

export const ScreenDetail = ({ screen }: { readonly screen: ScreenPayload }) => {
  const { t } = useI18n()
  const headingId = useId()
  return (
    <article
      aria-labelledby={headingId}
      data-slot="screen-detail"
      data-screen-id={screen.id}
      className="overflow-hidden rounded-xl border bg-card text-card-foreground shadow-xs"
    >
      <DetailHeader screen={screen} headingId={headingId} />
      {screen.redirectTo === null ? (
        <DetailSections screen={screen} />
      ) : (
        <SectionFrame sectionKey="redirect" title={t("sectionRedirect")} term="redirects">
          <RedirectTarget target={screen.redirectTo} />
        </SectionFrame>
      )}
    </article>
  )
}
