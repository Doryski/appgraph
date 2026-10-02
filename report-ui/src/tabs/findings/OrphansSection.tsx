import { Button } from "@/components/ui/button"
import { usePayload } from "@/app/report-context"
import { selectScreen } from "@/lib/url-state"
import { EmptyLine } from "./EmptyLine"
import { FindingSection } from "./FindingSection"

const openScreen = (id: string) => selectScreen(id, "push")

export const OrphansSection = () => {
  const { orphanScreens, screens } = usePayload()
  const labels = new Map(screens.map((screen) => [screen.id, screen.primaryLabel]))
  return (
    <FindingSection id="findings-orphans" titleKey="findingsOrphansTitle" introKey="findingsOrphansIntro" term="orphans" tone="info">
      {orphanScreens.length === 0 ? (
        <EmptyLine textKey="findingsOrphansEmpty" />
      ) : (
        <ul className="flex flex-wrap gap-2">
          {orphanScreens.map((id) => (
            <li key={id}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="font-mono text-xs pointer-coarse:h-11"
                onClick={() => openScreen(id)}
              >
                {labels.get(id) ?? id}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </FindingSection>
  )
}
