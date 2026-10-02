import { byCodepoint } from "@appgraph/emit/html-util.js"
import { CopyButton } from "@/components/CopyButton"
import { useI18n } from "@/app/report-context"

export const Dash = () => {
  const { t } = useI18n()
  return <span className="text-muted-foreground">{t("dash")}</span>
}

type LocationCellProps = {
  readonly file: string | null
  readonly line: number | null
}

export const locationText = (file: string | null, line: number | null): string => {
  if (file === null) return ""
  return line === null ? file : `${file}:${line}`
}

export const LocationCell = ({ file, line }: LocationCellProps) => {
  if (file === null) return <Dash />
  const location = locationText(file, line)
  return (
    <span className="inline-flex items-center gap-1">
      <span className="break-all">{location}</span>
      <CopyButton value={location} what={location} />
    </span>
  )
}

type Located = {
  readonly file: string | null
  readonly line: number | null
}

const NO_LINE = -1

export const compareLocation = (a: Located, b: Located): number =>
  byCodepoint(a.file ?? "", b.file ?? "") || (a.line ?? NO_LINE) - (b.line ?? NO_LINE)
