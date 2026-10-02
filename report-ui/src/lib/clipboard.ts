import { toast } from "sonner"

export type CopyToastLabels = {
  readonly success: string
  readonly failure: string
}

const copyWithExecCommand = (text: string): boolean => {
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    area.remove()
  }
}

const copyWithClipboardApi = async (text: string): Promise<boolean> => {
  if (typeof navigator === "undefined" || !navigator.clipboard) return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

export const copyText = async (text: string): Promise<boolean> =>
  (await copyWithClipboardApi(text)) || copyWithExecCommand(text)

export const copyWithToast = async (text: string, labels: CopyToastLabels) => {
  const copied = await copyText(text)
  if (copied) {
    toast.success(labels.success)
    return
  }
  toast.error(labels.failure)
}
