import type { LucideIcon } from "lucide-react"
import { Info, TriangleAlert } from "lucide-react"
import type { ReactNode } from "react"
import type { StringKey } from "@appgraph/emit/strings.js"
import { GlossaryTip, InfoTipLabel } from "@/components/InfoTip"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import type { GlossaryTermId } from "@/config/glossary"
import { useI18n } from "@/app/report-context"
import { cn } from "@/lib/utils"

export const FINDING_TONES = ["alarm", "info", "neutral"] as const

export type FindingTone = (typeof FINDING_TONES)[number]

type FindingSectionProps = {
  readonly id: string
  readonly titleKey: StringKey
  readonly introKey?: StringKey
  readonly term?: GlossaryTermId
  readonly tone?: FindingTone
  readonly alarmText?: string
  readonly children: ReactNode
}

type HeadingProps = Pick<FindingSectionProps, "titleKey" | "term"> & { readonly id: string }

const Heading = ({ id, titleKey, term }: HeadingProps) => {
  const { t } = useI18n()
  return (
    <InfoTipLabel tip={term && <GlossaryTip id={term} />}>
      <h2 id={id} className="text-base leading-normal font-medium">
        {t(titleKey)}
      </h2>
    </InfoTipLabel>
  )
}

type IntroProps = { readonly introKey?: StringKey; readonly icon?: LucideIcon }

const Intro = ({ introKey, icon: Icon }: IntroProps) => {
  const { t } = useI18n()
  if (introKey === undefined) return null
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      {Icon && <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />}
      {t(introKey)}
    </p>
  )
}

const AlarmHeader = ({ id, titleKey, introKey, term, alarmText }: HeadingProps & Pick<FindingSectionProps, "introKey" | "alarmText">) => {
  const { t } = useI18n()
  return (
    <Alert variant="destructive" className="border-destructive/40 bg-destructive/5">
      <TriangleAlert aria-hidden />
      <AlertTitle>
        <Heading id={id} titleKey={titleKey} term={term} />
      </AlertTitle>
      <AlertDescription>
        <p className="font-semibold">{alarmText}</p>
        {introKey !== undefined && <p>{t(introKey)}</p>}
      </AlertDescription>
    </Alert>
  )
}

export const FindingSection = ({
  id,
  titleKey,
  introKey,
  term,
  tone = "neutral",
  alarmText,
  children,
}: FindingSectionProps) => {
  const headingId = `${id}-heading`
  const isAlarm = tone === "alarm" && alarmText !== undefined
  return (
    <section aria-labelledby={headingId} data-slot="finding-section" data-tone={isAlarm ? "alarm" : tone}>
      <Card className={cn(isAlarm && "ring-destructive/30")}>
        <CardHeader className="gap-2">
          {isAlarm ? (
            <AlarmHeader id={headingId} titleKey={titleKey} introKey={introKey} term={term} alarmText={alarmText} />
          ) : (
            <>
              <Heading id={headingId} titleKey={titleKey} term={term} />
              <Intro introKey={introKey} icon={tone === "info" ? Info : undefined} />
            </>
          )}
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </section>
  )
}
