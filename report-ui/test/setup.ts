import "@testing-library/jest-dom/vitest"
import { cleanup } from "@testing-library/react"
import { afterEach, vi } from "vitest"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const matchMediaStub = (query: string): MediaQueryList => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})

vi.stubGlobal("ResizeObserver", ResizeObserverStub)
window.matchMedia = matchMediaStub
Element.prototype.scrollIntoView = () => {}
Element.prototype.scrollTo = () => {}
window.scrollTo = () => {}

Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: { writeText: vi.fn(() => Promise.resolve()) },
})

afterEach(() => {
  cleanup()
})
