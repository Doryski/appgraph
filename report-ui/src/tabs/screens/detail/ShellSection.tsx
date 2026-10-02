import { ChevronRight } from "lucide-react"
import type { ReportPayload } from "@appgraph/emit/report-payload.js"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { useI18n } from "@/app/report-context"
import { FilePath } from "./FilePath"
import { NavChips } from "./NavChips"
import { RenderTree } from "./RenderTree"

export type ShellPayload = ReportPayload["shells"][number]

export const ShellSection = ({ shell }: { readonly shell: ShellPayload }) => {
  const { t } = useI18n()
  return (
    <div data-slot="shell" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-[13px] font-semibold">{shell.layouts.join(", ")}</span>
        <FilePath file={shell.file} />
      </div>
      <p className="text-sm text-muted-foreground">{t("shellLinksIntro")}</p>
      {shell.navChips.length > 0 ? (
        <NavChips chips={shell.navChips} />
      ) : (
        <p className="text-sm text-muted-foreground italic">{t("emptyShellLinks")}</p>
      )}
      {shell.tree.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger
            render={<Button type="button" variant="ghost" size="sm" className="group/shell -ms-2 pointer-coarse:h-11" />}
          >
            <ChevronRight aria-hidden className="transition-transform group-aria-expanded/shell:rotate-90" />
            {t("shellTreeSummary")}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <RenderTree nodes={shell.tree} />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  )
}
