import type { Globals, Plugin } from "./types.ts"

export interface PageviewsOptions {
  /** The fragment is the route (`#/pricing`): hash changes are pageviews and the fragment is kept. */
  hash?: boolean
  /** Send the landing pageview. Default `true`. */
  initial?: boolean
}

/** Pageviews for the landing page and every same-document navigation, for any SPA router. */
export const pageviews = ({ hash = false, initial = true }: PageviewsOptions = {}): Plugin => ({
  name: "pageviews",
  setup(core) {
    const w = window as Window & Globals
    const h = history
    const l = location
    const undo: (() => void)[] = []
    const route = (): string => l.pathname + l.search + (hash ? l.hash : "")
    let last: string | undefined

    const view = (later?: unknown): void => {
      const now = route()
      const url = l.href

      if (now !== last) {
        last = now
        // A router sets the title after it changes the URL, so the title is read one macrotask later.
        if (later) {
          setTimeout(() => core.client.pageview({ url }))
        } else {
          core.client.pageview()
        }
      }
    }

    const listen = (target: EventTarget, type: string): void => {
      target.addEventListener(type, view)
      undo.push(() => target.removeEventListener(type, view))
    }

    core.state.hash = hash

    if (w.navigation) {
      listen(w.navigation, "navigatesuccess")
    } else {
      for (const name of ["pushState", "replaceState"] as const) {
        const previous = h[name]
        const patched = function (this: History, ...args: Parameters<History["pushState"]>): void {
          previous.apply(this, args)
          view(1)
        }

        h[name] = patched
        // Only while ours is still the outermost patch; unwrapping someone else's would remove theirs.
        undo.push(() => {
          if (h[name] === patched) {
            h[name] = previous
          }
        })
      }

      listen(w, "popstate")
    }

    if (hash) {
      listen(w, "hashchange")
    }

    if (initial) {
      // A microtask later, so a consent answer given right after createMira() applies to the landing page.
      core.ready(view)
    } else {
      last = route()
    }

    return () => undo.forEach((run) => run())
  }
})
