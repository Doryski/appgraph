import { Repeat2, Scissors } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { TreeNode } from "@appgraph/core/model.js"
import type { StringKey } from "@appgraph/emit/strings.js"
import { Badge } from "@/components/ui/badge"
import { useI18n } from "@/app/report-context"
import type { Translate } from "@/lib/i18n"
import { TagPopover } from "./TagPopover"

const VIA_BADGES = {
  lazy: { labelKey: "treeViaLazyLabel", helpKey: "treeViaLazyTitle" },
  reference: { labelKey: "treeViaReferenceLabel", helpKey: "treeViaReferenceTitle" },
  selector: { labelKey: "treeViaSelectorLabel", helpKey: "treeViaSelectorTitle" },
  "selector-global": { labelKey: "treeViaSelectorGlobalLabel", helpKey: "treeViaSelectorGlobalTitle" },
} as const satisfies Record<NonNullable<TreeNode["via"]>, { readonly labelKey: StringKey; readonly helpKey: StringKey }>

const CONDITION_KEYS = {
  sometimes: { labelKey: "treeCondAlways", helpKey: "helpCondSometimes" },
  only: { labelKey: "treeCondOnly", helpKey: "helpCondOnly" },
} as const satisfies Record<string, { readonly labelKey: StringKey; readonly helpKey: StringKey }>

const CONDITIONS_PARAM = "{{conditions}}"

const conditionText = (t: Translate, key: StringKey, condition: string): string => {
  const template = t(key)
  return template.includes(CONDITIONS_PARAM) ? t(key, { conditions: condition }) : `${template}${condition}`
}

const moreSuffix = (values: readonly string[]): string => (values.length > 1 ? ` +${values.length - 1}` : "")

type NoteProps = {
  readonly icon: LucideIcon
  readonly text: string
  readonly note: string
}

const Note = ({ icon: Icon, text, note }: NoteProps) => (
  <Badge variant="outline" data-note={note} className="text-muted-foreground italic">
    <Icon aria-hidden />
    {text}
  </Badge>
)

type TreeTagsProps = {
  readonly node: TreeNode
}

export const TreeTags = ({ node }: TreeTagsProps) => {
  const { t } = useI18n()
  const via = node.via === undefined ? null : VIA_BADGES[node.via]
  const firstCondition = node.via === "reference" ? undefined : node.conditions[0]
  const condition = CONDITION_KEYS[node.alwaysRendered ? "sometimes" : "only"]
  const firstGuard = node.nullGuards[0]
  return (
    <>
      {via && <TagPopover tag="via" tone="via" label={t(via.labelKey)} help={t(via.helpKey)} />}
      {firstCondition !== undefined && (
        <TagPopover
          tag="condition"
          tone="condition"
          label={`${conditionText(t, condition.labelKey, firstCondition)}${moreSuffix(node.conditions)}`}
          help={t(condition.helpKey)}
          items={node.conditions}
        />
      )}
      {node.repeated && (
        <TagPopover
          tag="repeated"
          tone="repeated"
          label={t("treeRepeatedLabel")}
          help={t("helpRepeated")}
          items={[t("treeRepeatedTitle")]}
        />
      )}
      {firstGuard !== undefined && (
        <TagPopover
          tag="guard"
          tone="guard"
          label={`${t("treeGuardLabel", { guard: firstGuard })}${moreSuffix(node.nullGuards)}`}
          help={t("helpGuard")}
          items={node.nullGuards}
        />
      )}
      {node.repeat && <Note icon={Repeat2} note="repeat" text={t("treeRepeatNote")} />}
      {node.truncated && <Note icon={Scissors} note="truncated" text={t("treeTruncatedNote")} />}
    </>
  )
}
