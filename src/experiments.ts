import { bucket } from "./protocol/hash.ts"
import type { Globals, Plugin } from "./types.ts"

/** `$exposure` for page experiments drawn by the MIRA FIVE head snippet (FLAGS.md §6). Needs flags() and identity(). */
export const experiments = (): Plugin => ({
  name: "experiments",
  setup(core) {
    const { state } = core
    const entries = ((window as Window & Globals).__mirafive_experiments ??= [])
    const { push } = entries
    const done = new Set<string>()

    const check = (): void => {
      // The document's `orig` must be known first, and the pending id has to have become the anonymous id.
      const id =
        state.consent?.experiments && state.mode === "full" && state.flags ? state.aid?.() : undefined

      for (const { k, v, s, w, b, h } of entries) {
        if (id && !done.has(k)) {
          done.add(k)

          let point = bucket(s, ".v", id)
          const drawn = w.findIndex((weight) => (point -= weight) < 0)

          if (String.fromCharCode(97 + Math.max(drawn, 0)) === v && !state.flags?.orig?.includes(k)) {
            core.send("$exposure", { $experiment: k, $variant: v, $boot: b, $snippet: h })
          }
        }
      }
    }

    entries.push = (...added) => {
      const length = push.apply(entries, added)

      check()
      return length
    }

    const offs = [core.on("consent", check), core.on("flags", check)]

    check()

    return () => {
      entries.push = push
      offs.forEach((off) => off())
    }
  }
})
