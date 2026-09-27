// Vendored from mirafive/protocol 5037788489cb. Do not edit; run bun run vendor:protocol.
export const KEY_PATTERN: RegExp = /^mf_[a-z0-9]{8}_[A-Za-z0-9_-]+$/

/** The part before the last `_`: names local storage so the key's tail is never stored. */
export const keyNamespace = (key: string): string => {
  const cut = key.lastIndexOf("_")

  return cut > 0 ? key.slice(0, cut) : "default"
}
