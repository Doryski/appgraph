import { BookOpen } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { useI18n } from "@/app/report-context"
import { GLOSSARY } from "@/config/glossary"
import { HEADER_ACTION_CLASS, HEADER_ACTION_LABEL_CLASS } from "@/components/header-action"

export const GlossaryDialog = () => {
  const { t } = useI18n()
  return (
    <Dialog>
      <DialogTrigger
        render={<Button type="button" variant="ghost" className={HEADER_ACTION_CLASS} />}
      >
        <BookOpen aria-hidden />
        <span className={HEADER_ACTION_LABEL_CLASS}>{t("glossaryOpen")}</span>
      </DialogTrigger>
      <DialogContent closeLabel={t("dialogClose")} className="flex max-h-[85dvh] flex-col gap-4 sm:max-w-2xl">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-semibold">{t("glossaryTitle")}</DialogTitle>
          <DialogDescription>{t("glossaryIntro")}</DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto overscroll-contain border-t">
          <dl className="grid gap-x-6 px-6 sm:grid-cols-[minmax(8rem,auto)_1fr]">
            {GLOSSARY.map((term) => (
              <div
                key={term.id}
                data-slot="glossary-term"
                className="grid gap-1 border-b py-3 last:border-b-0 sm:col-span-2 sm:grid-cols-subgrid sm:gap-6"
              >
                <dt className="font-mono text-[13px] font-medium first-letter:uppercase">{t(term.labelKey)}</dt>
                <dd className="leading-relaxed text-muted-foreground">{t(term.helpKey)}</dd>
              </div>
            ))}
          </dl>
        </div>
      </DialogContent>
    </Dialog>
  )
}
