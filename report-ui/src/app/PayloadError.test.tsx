import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { readPayload } from "@/lib/payload"
import { PayloadError } from "./PayloadError"
import { ReportErrorBoundary } from "./ReportErrorBoundary"

const BrokenReport = () => {
  throw new Error("payload field missing")
}

describe("PayloadError", () => {
  it("explains that the report data could not be read", () => {
    document.getElementById("appgraph-data")?.remove()
    expect(readPayload(document)).toBeNull()
    render(<PayloadError />)
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be read/)
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument()
  })
})

describe("ReportErrorBoundary", () => {
  it("renders the payload error instead of a blank page when rendering throws", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <ReportErrorBoundary>
        <BrokenReport />
      </ReportErrorBoundary>,
    )
    expect(screen.getByRole("alert")).toHaveTextContent(/could not be read/)
    consoleError.mockRestore()
  })

  it("renders its children when nothing throws", () => {
    render(
      <ReportErrorBoundary>
        <p>report body</p>
      </ReportErrorBoundary>,
    )
    expect(screen.getByText("report body")).toBeInTheDocument()
  })
})
