import { Badge } from "@/components/ui/badge"

type KindBadgeProps = {
  readonly kind: string
  readonly slug: string | undefined
}

export const KindBadge = ({ kind, slug }: KindBadgeProps) => (
  <Badge variant="outline" className="gap-1.5 font-mono">
    {slug ? (
      <span
        aria-hidden
        data-slot="kind-dot"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: `var(--kind-color-${slug})` }}
      />
    ) : null}
    {kind}
  </Badge>
)
