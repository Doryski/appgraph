import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useI18n } from "@/app/report-context"
import { HOTKEY_GROUPS, hotkeysInGroup, isSequenceEntry } from "@/hotkeys/config"
import type { HotkeyEntry } from "@/hotkeys/config"
import { KeyList } from "@/hotkeys/KeyCombo"

const ALTERNATIVE_SEPARATOR = "/"

const EntryKeys = ({ entry }: { readonly entry: HotkeyEntry }) => {
  const { t } = useI18n()
  if (isSequenceEntry(entry)) return <KeyList keys={entry.sequence} separator={t("shortcutThen")} />
  return <KeyList keys={entry.keys} separator={ALTERNATIVE_SEPARATOR} />
}

type ShortcutsDialogProps = {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}

export const ShortcutsDialog = ({ open, onOpenChange }: ShortcutsDialogProps) => {
  const { t } = useI18n()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={t("dialogClose")} className="flex max-h-[85dvh] flex-col gap-4 sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle className="text-lg font-semibold">{t("shortcutsTitle")}</DialogTitle>
          <DialogDescription>{t("shortcutsIntro")}</DialogDescription>
        </DialogHeader>
        <div className="-mx-6 min-h-0 flex-1 overflow-y-auto overscroll-contain border-t px-6">
          {HOTKEY_GROUPS.map((group) => (
            <section key={group.id} data-slot="shortcut-group" aria-labelledby={`shortcut-group-${group.id}`} className="py-3">
              <h3
                id={`shortcut-group-${group.id}`}
                className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
              >
                {t(group.labelKey)}
              </h3>
              <dl className="divide-y">
                {hotkeysInGroup(group.id).map((entry) => (
                  <div key={entry.id} data-slot="shortcut" data-shortcut-id={entry.id} className="flex items-center justify-between gap-4 py-2">
                    <dt className="leading-snug">{t(entry.labelKey)}</dt>
                    <dd className="shrink-0">
                      <EntryKeys entry={entry} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
