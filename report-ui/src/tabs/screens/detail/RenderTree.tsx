import { ChevronRight } from "lucide-react"
import type { TreeNode } from "@appgraph/core/model.js"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { KindBadge } from "@/tabs/components/KindBadge"
import { cn } from "@/lib/utils"
import { FilePath } from "./FilePath"
import { usePaletteSlugs } from "./palette"
import type { PaletteSlugs } from "./palette"
import { TreeTags } from "./TreeTags"

const DEFAULT_OPEN_DEPTH = 2

type TreeListProps = {
  readonly nodes: readonly TreeNode[]
  readonly depth: number
  readonly slugs: PaletteSlugs
}

const NodeLine = ({ node, slugs, toggle }: { readonly node: TreeNode; readonly slugs: PaletteSlugs; readonly toggle: boolean }) => (
  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1">
    {toggle ? (
      <CollapsibleTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={node.component}
            className="group/toggle relative shrink-0 after:absolute after:-inset-1.5 pointer-coarse:after:-inset-2.5"
          />
        }
      >
        <ChevronRight aria-hidden className="transition-transform group-aria-expanded/toggle:rotate-90" />
      </CollapsibleTrigger>
    ) : (
      <span aria-hidden className="inline-block size-6 shrink-0" />
    )}
    <KindBadge kind={node.kind} slug={slugs.kindSlug(node.kind)} />
    <span className="font-mono text-[13px] font-semibold break-all">{node.component}</span>
    <FilePath file={node.file} className="max-w-[min(100%,28rem)]" />
    <TreeTags node={node} />
  </div>
)

const TreeItem = ({ node, depth, slugs }: { readonly node: TreeNode; readonly depth: number; readonly slugs: PaletteSlugs }) => {
  if (node.children.length === 0) {
    return (
      <li data-slot="tree-node">
        <NodeLine node={node} slugs={slugs} toggle={false} />
      </li>
    )
  }
  return (
    <li data-slot="tree-node">
      <Collapsible defaultOpen={depth < DEFAULT_OPEN_DEPTH}>
        <NodeLine node={node} slugs={slugs} toggle />
        <CollapsibleContent>
          <TreeList nodes={node.children} depth={depth + 1} slugs={slugs} />
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

const TreeList = ({ nodes, depth, slugs }: TreeListProps) => (
  <ul className={cn("flex flex-col", depth > 0 && "ms-3 border-s border-border ps-3")}>
    {nodes.map((node, index) => (
      <TreeItem key={`${index}:${node.file}:${node.component}`} node={node} depth={depth} slugs={slugs} />
    ))}
  </ul>
)

export const RenderTree = ({ nodes }: { readonly nodes: readonly TreeNode[] }) => {
  const slugs = usePaletteSlugs()
  return (
    <div data-slot="render-tree" className="overflow-x-auto">
      <TreeList nodes={nodes} depth={0} slugs={slugs} />
    </div>
  )
}
