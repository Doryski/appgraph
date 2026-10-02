import { afterEach, describe, expect, it, vi } from "vitest"
import { toast } from "sonner"
import { copyText, copyWithToast } from "./clipboard"

const execCommand = vi.fn<(command: string) => boolean>()

Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand })

afterEach(() => {
  vi.restoreAllMocks()
  execCommand.mockReset()
})

const rejectClipboard = () =>
  vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => Promise.reject(new Error("blocked")))

describe("copyText", () => {
  it("uses the Clipboard API", async () => {
    const write = vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => Promise.resolve())
    await expect(copyText("/a")).resolves.toBe(true)
    expect(write).toHaveBeenCalledWith("/a")
    expect(execCommand).not.toHaveBeenCalled()
  })

  it("falls back to execCommand when the Clipboard API rejects", async () => {
    rejectClipboard()
    execCommand.mockReturnValue(true)
    await expect(copyText("/b")).resolves.toBe(true)
    expect(execCommand).toHaveBeenCalledWith("copy")
    expect(document.querySelector("textarea")).toBeNull()
  })

  it("reports failure when both paths fail", async () => {
    rejectClipboard()
    execCommand.mockReturnValue(false)
    await expect(copyText("/c")).resolves.toBe(false)
  })
})

describe("copyWithToast", () => {
  const labels = { success: "Copied", failure: "Could not copy" } as const

  it("shows a success toast", async () => {
    vi.spyOn(navigator.clipboard, "writeText").mockImplementation(() => Promise.resolve())
    const success = vi.spyOn(toast, "success")
    await copyWithToast("/a", labels)
    expect(success).toHaveBeenCalledWith("Copied")
  })

  it("shows an error toast on failure", async () => {
    rejectClipboard()
    execCommand.mockReturnValue(false)
    const error = vi.spyOn(toast, "error")
    await copyWithToast("/a", labels)
    expect(error).toHaveBeenCalledWith("Could not copy")
  })
})
