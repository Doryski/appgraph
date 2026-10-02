import type { StringKey } from "@appgraph/emit/strings.js"

export const SHOW_EMPTY_SECTIONS_KEY = "showEmptySections" as const satisfies StringKey

export const SELECTION_HIDDEN_KEY = "screenSelectionHidden" as const satisfies StringKey

export const ENDPOINT_FILTER_LABEL_KEY = "endpointFilterLabel" as const satisfies StringKey

export const ENDPOINT_FILTER_EXAMPLE_KEY = "endpointFilterExample" as const satisfies StringKey

export const ENDPOINT_FILTER_EMPTY_KEY = "endpointFilterEmpty" as const satisfies StringKey

export const ENDPOINT_METHOD_COLUMN_KEY = "colMethod" as const satisfies StringKey

export const ENDPOINT_URL_COLUMN_KEY = "colUrl" as const satisfies StringKey

export const ENDPOINT_TRANSPORT_COLUMN_KEY = "glossaryTermTransport" as const satisfies StringKey

export const ENDPOINT_CLIENT_COLUMN_KEY = "colClient" as const satisfies StringKey
