import { Component } from "react"
import type { ReactNode } from "react"
import { PayloadError } from "@/app/PayloadError"

type ReportErrorBoundaryProps = {
  readonly children: ReactNode
}

type ReportErrorBoundaryState = {
  readonly failed: boolean
}

export class ReportErrorBoundary extends Component<ReportErrorBoundaryProps, ReportErrorBoundaryState> {
  override state: ReportErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ReportErrorBoundaryState {
    return { failed: true }
  }

  override render() {
    return this.state.failed ? <PayloadError /> : this.props.children
  }
}
