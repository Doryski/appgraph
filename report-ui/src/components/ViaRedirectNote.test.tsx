import { screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { interpolate } from "@appgraph/emit/i18n-runtime.js"
import { stringTable } from "@appgraph/emit/strings.js"
import { renderInReport } from "@/app/test-utils"
import { ViaRedirectNote } from "./ViaRedirectNote"

const en = stringTable("en")

describe("ViaRedirectNote", () => {
  it("renders nothing without a redirect", () => {
    const { container } = renderInReport(<ViaRedirectNote via={undefined} />)
    expect(container.querySelector('[data-slot="via-redirect"]')).toBeNull()
  })

  it("names the redirect's source and target", () => {
    renderInReport(<ViaRedirectNote via={{ from: "/old", to: "/new" }} />)
    expect(screen.getByText(interpolate(en.navViaRedirect, { from: "/old", to: "/new" }))).toBeInTheDocument()
  })

  it("spells out the redirect's condition as text", () => {
    const via = { from: "/settings", to: "/settings/general", condition: "authority = SYS_ADMIN" }
    renderInReport(<ViaRedirectNote via={via} />)
    expect(screen.getByText("via redirect /settings → /settings/general (when authority = SYS_ADMIN)")).toBeInTheDocument()
    expect(screen.getByText(interpolate(en.navViaRedirectWhen, via))).toHaveAttribute("data-slot", "via-redirect")
  })

  it("lists every alternative target with its condition", () => {
    const via = {
      from: "/settings",
      to: "/settings/general",
      condition: "authority = SYS_ADMIN",
      alternatives: [
        { to: "/settings/general", condition: "authority = SYS_ADMIN" },
        { to: "/settings/home", condition: "authority = TENANT_ADMIN" },
      ],
    }
    renderInReport(<ViaRedirectNote via={via} />)
    expect(
      screen.getByText(
        "via redirect /settings → /settings/general (when authority = SYS_ADMIN) · /settings/home (when authority = TENANT_ADMIN)",
      ),
    ).toHaveAttribute("data-slot", "via-redirect")
  })

  it("falls back to the single-target text with fewer than two alternatives", () => {
    const via = {
      from: "/x",
      to: "/home",
      condition: "beta",
      alternatives: [{ to: "/home", condition: "beta" }],
    }
    renderInReport(<ViaRedirectNote via={via} />)
    expect(screen.getByText(interpolate(en.navViaRedirectWhen, { from: "/x", to: "/home", condition: "beta" }))).toBeInTheDocument()
  })
})
