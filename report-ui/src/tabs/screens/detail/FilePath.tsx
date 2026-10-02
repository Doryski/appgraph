import { CopyButton } from "@/components/CopyButton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

type FilePathProps = {
  readonly file: string
  readonly className?: string
}

export const FilePath = ({ file, className }: FilePathProps) => (
  <span data-slot="file-path" className={cn("group/path inline-flex min-w-0 max-w-full items-center gap-0.5", className)}>
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="min-w-0 truncate rounded-sm font-mono text-xs text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        }
      >
        {file}
      </TooltipTrigger>
      <TooltipContent className="max-w-lg font-mono break-all">{file}</TooltipContent>
    </Tooltip>
    <CopyButton
      value={file}
      what={file}
      className="shrink-0 opacity-50 group-hover/path:opacity-100 group-focus-within/path:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
    />
  </span>
)
