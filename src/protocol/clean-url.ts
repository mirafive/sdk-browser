// Vendored from mirafive/protocol 5037788489cb. Do not edit; run bun run vendor:protocol.
import { KEPT_QUERY_PARAMETERS } from "./limits.ts"

const kept = (part: string): boolean => {
  const name = part.split("=", 1)[0] ?? ""

  return name.startsWith("utm_") || (KEPT_QUERY_PARAMETERS as readonly string[]).includes(name)
}

const query = (search: string): string => search.slice(1).split("&").filter(kept).join("&")

/**
 * Keeps only campaign and click-id parameters, in their original encoding. With `hash` the fragment stays,
 * its own query cleaned the same way; otherwise it is dropped. A URL that does not parse loses query and fragment.
 */
export const cleanUrl = (href: string, hash = false): string => {
  let url: URL

  try {
    url = new URL(href)
  } catch {
    return href.split(/[?#]/, 1)[0] ?? ""
  }

  url.search = query(url.search)

  if (!hash) {
    url.hash = ""
  } else if (url.hash.includes("?")) {
    const at = url.hash.indexOf("?")
    const rest = query(url.hash.slice(at))

    url.hash = url.hash.slice(1, at) + (rest ? `?${rest}` : "")
  }

  return url.href
}
