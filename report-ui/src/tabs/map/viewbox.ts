export type View = {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export type ClientRect = {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export const ZOOM_STEP = 1.25
export const MIN_ZOOM_RATIO = 0.1
export const MAX_ZOOM_RATIO = 2
export const WHEEL_SENSITIVITY = 0.002
export const VISIBLE_SHARE = 0.25
const REVEAL_MARGIN = 24
const EPSILON = 1e-6

export const baseView = (width: number, height: number): View => ({ x: 0, y: 0, w: width, h: height })

export const formatViewBox = (view: View): string =>
  [view.x, view.y, view.w, view.h].map((value) => Number(value.toFixed(2))).join(" ")

const clampNumber = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

const clampAxis = (start: number, size: number, extent: number): number => {
  const keep = Math.min(size, extent) * VISIBLE_SHARE
  return clampNumber(start, keep - size, extent - keep)
}

export const clampView = (view: View, base: View): View => ({
  ...view,
  x: clampAxis(view.x, view.w, base.w),
  y: clampAxis(view.y, view.h, base.h),
})

export const canZoomIn = (view: View, base: View): boolean => view.w > base.w * MIN_ZOOM_RATIO + EPSILON

export const canZoomOut = (view: View, base: View): boolean => view.w < base.w * MAX_ZOOM_RATIO - EPSILON

export const isFitted = (view: View, base: View): boolean =>
  Math.abs(view.x - base.x) < EPSILON &&
  Math.abs(view.y - base.y) < EPSILON &&
  Math.abs(view.w - base.w) < EPSILON &&
  Math.abs(view.h - base.h) < EPSILON

export const zoomAt = (view: View, base: View, factor: number, cx: number, cy: number): View => {
  const width = clampNumber(view.w * factor, base.w * MIN_ZOOM_RATIO, base.w * MAX_ZOOM_RATIO)
  const scale = width / view.w
  return clampView(
    { x: cx - (cx - view.x) * scale, y: cy - (cy - view.y) * scale, w: width, h: view.h * scale },
    base,
  )
}

export const zoomCentered = (view: View, base: View, factor: number): View =>
  zoomAt(view, base, factor, view.x + view.w / 2, view.y + view.h / 2)

export const panTo = (view: View, base: View, x: number, y: number): View => clampView({ ...view, x, y }, base)

const isInside = (view: View, x: number, y: number): boolean =>
  x >= view.x + REVEAL_MARGIN &&
  x <= view.x + view.w - REVEAL_MARGIN &&
  y >= view.y + REVEAL_MARGIN &&
  y <= view.y + view.h - REVEAL_MARGIN

export const reveal = (view: View, base: View, x: number, y: number): View =>
  isInside(view, x, y) ? view : panTo(view, base, x - view.w / 2, y - view.h / 2)

export const unitsPerPixel = (view: View, rect: ClientRect): number =>
  rect.width <= 0 || rect.height <= 0 ? 1 : Math.max(view.w / rect.width, view.h / rect.height)

export const clientToView = (view: View, rect: ClientRect, clientX: number, clientY: number) => {
  const scale = unitsPerPixel(view, rect)
  const offsetX = (rect.width * scale - view.w) / 2
  const offsetY = (rect.height * scale - view.h) / 2
  return {
    x: view.x - offsetX + (clientX - rect.left) * scale,
    y: view.y - offsetY + (clientY - rect.top) * scale,
  }
}
