import type { StringKey } from "@appgraph/emit/strings.js"
import type { LucideIcon } from "lucide-react"
import { Monitor, Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useI18n } from "@/app/report-context"
import { HEADER_ACTION_CLASS } from "@/components/header-action"
import { THEMES, setTheme, useTheme } from "@/lib/theme"
import type { Theme } from "@/lib/theme"

const THEME_OPTIONS = [
  { id: "light", labelKey: "themeLight", icon: Sun },
  { id: "dark", labelKey: "themeDark", icon: Moon },
  { id: "system", labelKey: "themeSystem", icon: Monitor },
] as const satisfies readonly { readonly id: Theme; readonly labelKey: StringKey; readonly icon: LucideIcon }[]

const optionFor = (theme: Theme) => THEME_OPTIONS.find((option) => option.id === theme) ?? THEME_OPTIONS[2]

const toTheme = (value: unknown): Theme | undefined => THEMES.find((theme) => theme === value)

const selectTheme = (value: unknown) => {
  const theme = toTheme(value)
  if (theme) setTheme(theme)
}

export const ThemeMenu = () => {
  const { t } = useI18n()
  const theme = useTheme()
  const CurrentIcon = optionFor(theme).icon
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" className={HEADER_ACTION_CLASS} aria-label={t("themeMenuLabel")} />}>
        <CurrentIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("themeMenuLabel")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={theme} onValueChange={selectTheme}>
            {THEME_OPTIONS.map(({ id, labelKey, icon: Icon }) => (
              <DropdownMenuRadioItem key={id} value={id} closeOnClick className="pointer-coarse:min-h-11">
                <Icon aria-hidden />
                {t(labelKey)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
