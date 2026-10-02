export const VIRTUAL_VIEWPORT = { width: 800, height: 600 } as const

const sizeProperties = [
  ["offsetHeight", VIRTUAL_VIEWPORT.height],
  ["offsetWidth", VIRTUAL_VIEWPORT.width],
  ["clientHeight", VIRTUAL_VIEWPORT.height],
  ["clientWidth", VIRTUAL_VIEWPORT.width],
] as const

const fixedRect = (): DOMRect => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: VIRTUAL_VIEWPORT.width,
  bottom: VIRTUAL_VIEWPORT.height,
  width: VIRTUAL_VIEWPORT.width,
  height: VIRTUAL_VIEWPORT.height,
  toJSON: () => ({}),
})

const descriptorOf = (property: string) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, property)

export const mockVirtualViewport = () => {
  const originalRect = HTMLElement.prototype.getBoundingClientRect
  const originals = sizeProperties.map(([property]) => [property, descriptorOf(property)] as const)

  HTMLElement.prototype.getBoundingClientRect = fixedRect
  sizeProperties.forEach(([property, value]) => {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, value })
  })

  return () => {
    HTMLElement.prototype.getBoundingClientRect = originalRect
    originals.forEach(([property, descriptor]) => {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, property, descriptor)
      else Reflect.deleteProperty(HTMLElement.prototype, property)
    })
  }
}
