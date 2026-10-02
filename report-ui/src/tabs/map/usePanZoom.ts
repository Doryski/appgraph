import { useCallback, useReducer, useRef, useState } from "react"
import type { MouseEvent, PointerEvent } from "react"
import {
  WHEEL_SENSITIVITY,
  ZOOM_STEP,
  baseView,
  canZoomIn,
  canZoomOut,
  clientToView,
  formatViewBox,
  isFitted,
  panTo,
  reveal,
  unitsPerPixel,
  zoomAt,
  zoomCentered,
} from "./viewbox"
import type { ClientRect, View } from "./viewbox"

export const DRAG_THRESHOLD_PX = 4

type PanZoomState = {
  readonly base: View
  readonly view: View
}

type PanZoomAction =
  | { readonly type: "zoomIn" }
  | { readonly type: "zoomOut" }
  | { readonly type: "fit" }
  | { readonly type: "wheel"; readonly factor: number; readonly clientX: number; readonly clientY: number; readonly rect: ClientRect }
  | { readonly type: "pan"; readonly x: number; readonly y: number }
  | { readonly type: "reveal"; readonly x: number; readonly y: number }

const nextView = (state: PanZoomState, action: PanZoomAction): View => {
  const { base, view } = state
  switch (action.type) {
    case "zoomIn":
      return zoomCentered(view, base, 1 / ZOOM_STEP)
    case "zoomOut":
      return zoomCentered(view, base, ZOOM_STEP)
    case "fit":
      return base
    case "wheel": {
      const point = clientToView(view, action.rect, action.clientX, action.clientY)
      return zoomAt(view, base, action.factor, point.x, point.y)
    }
    case "pan":
      return panTo(view, base, action.x, action.y)
    case "reveal":
      return reveal(view, base, action.x, action.y)
  }
}

export const panZoomReducer = (state: PanZoomState, action: PanZoomAction): PanZoomState => {
  const view = nextView(state, action)
  return view === state.view ? state : { ...state, view }
}

type Drag = {
  readonly pointerId: number
  readonly startX: number
  readonly startY: number
  readonly from: View
  readonly scale: number
  moved: boolean
}

const rectOf = (element: Element): ClientRect => {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

const exceedsThreshold = (drag: Drag, event: PointerEvent<SVGSVGElement>): boolean =>
  Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > DRAG_THRESHOLD_PX

export const usePanZoom = (width: number, height: number) => {
  const [state, dispatch] = useReducer(panZoomReducer, undefined, () => ({
    base: baseView(width, height),
    view: baseView(width, height),
  }))
  const [panning, setPanning] = useState(false)
  const dragRef = useRef<Drag | null>(null)
  const suppressClickRef = useRef(false)

  const wheelRef = useCallback((element: SVGSVGElement | null) => {
    if (element === null) return
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      dispatch({
        type: "wheel",
        factor: Math.exp(event.deltaY * WHEEL_SENSITIVITY),
        clientX: event.clientX,
        clientY: event.clientY,
        rect: rectOf(element),
      })
    }
    element.addEventListener("wheel", onWheel, { passive: false })
    return () => element.removeEventListener("wheel", onWheel)
  }, [])

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    suppressClickRef.current = false
    if (event.button !== 0) return
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      from: state.view,
      scale: unitsPerPixel(state.view, rectOf(event.currentTarget)),
      moved: false,
    }
  }

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    if (!drag.moved && !exceedsThreshold(drag, event)) return
    if (!drag.moved) {
      drag.moved = true
      setPanning(true)
      event.currentTarget.setPointerCapture?.(event.pointerId)
    }
    dispatch({
      type: "pan",
      x: drag.from.x - (event.clientX - drag.startX) * drag.scale,
      y: drag.from.y - (event.clientY - drag.startY) * drag.scale,
    })
  }

  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current
    if (drag === null || drag.pointerId !== event.pointerId) return
    suppressClickRef.current = drag.moved
    dragRef.current = null
    setPanning(false)
  }

  const onClickCapture = (event: MouseEvent<SVGSVGElement>) => {
    if (!suppressClickRef.current) return
    suppressClickRef.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  const isDragging = () => dragRef.current?.moved === true

  return {
    view: state.view,
    viewBox: formatViewBox(state.view),
    panning,
    canZoomIn: canZoomIn(state.view, state.base),
    canZoomOut: canZoomOut(state.view, state.base),
    fitted: isFitted(state.view, state.base),
    zoomIn: () => dispatch({ type: "zoomIn" }),
    zoomOut: () => dispatch({ type: "zoomOut" }),
    fit: () => dispatch({ type: "fit" }),
    reveal: (x: number, y: number) => dispatch({ type: "reveal", x, y }),
    isDragging,
    svgProps: {
      ref: wheelRef,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
      onClickCapture,
    },
  }
}

export type PanZoom = ReturnType<typeof usePanZoom>
