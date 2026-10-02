import { TriangleAlert } from "lucide-react"
import { InfoTip, InfoTipLabel } from "@/components/InfoTip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ViaRedirectNote } from "@/components/ViaRedirectNote"
import { useI18n } from "@/app/report-context"
import { selectScreen } from "@/lib/url-state"
import type { MenuRow } from "./rows"

type RowProps = {
  readonly row: MenuRow
}

export const GroupCell = ({ row }: RowProps) => {
  const { t } = useI18n()
  const shells = row.groupShells.length > 0 ? row.groupShells.join(", ") : t("menuShellsUnknown")
  return (
    <InfoTipLabel tip={<InfoTip term={row.group} help={t("menuIntro", { source: row.groupSource, shells })} />}>
      <span>{row.group}</span>
    </InfoTipLabel>
  )
}

export const PathCell = ({ row }: RowProps) => {
  const { t } = useI18n()
  const { linkedScreen } = row
  if (linkedScreen === null) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2">
        <span>{row.path}</span>
        <Badge variant="warning">
          <TriangleAlert aria-hidden />
          {t("menuMissingInRouter")}
        </Badge>
        <ViaRedirectNote via={row.viaRedirect} />
      </span>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant="link"
        size="sm"
        className="h-auto p-0 font-mono text-[inherit] pointer-coarse:min-h-11"
        onClick={() => selectScreen(linkedScreen, "push")}
      >
        {row.path}
      </Button>
      <ViaRedirectNote via={row.viaRedirect} />
    </span>
  )
}

type DashCellProps = {
  readonly value: string | null
}

export const DashCell = ({ value }: DashCellProps) => {
  const { t } = useI18n()
  if (value === null) return <span className="text-muted-foreground">{t("dash")}</span>
  return <span>{value}</span>
}

export const FlagCell = ({ row }: RowProps) => {
  if (row.featureFlag === null) return <DashCell value={null} />
  return <Badge variant="secondary">{row.featureFlag}</Badge>
}
