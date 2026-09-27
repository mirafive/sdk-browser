import { keyNamespace } from "./protocol/key.ts"
import type { ConsentAnswer, Globals, Plugin, Properties } from "./types.ts"

const year = 31536e6

/**
 * Consent, anonymous and session ids, and the signed-in user, for mode "full".
 * Nothing is stored before a consent scope is granted, nothing sent before statistics consent.
 */
export const identity = (): Plugin => ({
  name: "identity",
  setup(core) {
    const { state } = core
    const w = window as Window & Globals
    const ns = keyNamespace(core.options.key)
    const prefix = `mirafive:${ns}:`
    const memory: Record<string, string | undefined> = {}
    let resent = false

    if (core.options.mode !== "full") {
      return core.warn('identity() needs mode "full"')
    }

    const read = (name: string, maxAge: number): string | undefined => {
      let value: string | null | undefined

      try {
        value = localStorage.getItem(prefix + name)
      } catch {
        // Storage can throw (private modes, blocked contexts); memory stands in for this page.
      }

      const [id, seen] = (value ?? memory[name])?.split(".") ?? []

      return id && (seen === undefined || Date.now() - +seen < maxAge) ? id : undefined
    }

    const write = <Id extends string | undefined>(name: string, id: Id): Id => {
      const value = (memory[name] = id && `${id}.${Date.now()}`)

      try {
        if (value) {
          localStorage.setItem(prefix + name, value)
        } else {
          localStorage.removeItem(prefix + name)
        }
      } catch {
        // Kept in memory.
      }

      return id
    }

    const forget = (): void => ["aid", "sid", "uid"].forEach((name) => write(name, undefined))

    const any = (): boolean => Object.values(state.consent ?? {}).some(Boolean)

    const aid = (): string => {
      let id = read("aid", year)

      if (!id) {
        // A snippet may have drawn an experiment on a pending id; it becomes the anonymous id, once.
        id = w.__mirafive_aid_next || core.uuid()
        w.__mirafive_aid_next = undefined
      }

      return write("aid", id)
    }

    const allowed = (scope: unknown): boolean => !!scope && !core.optedOut()

    // A shared browser: the next person to sign in starts with fresh ids.
    const claim = (userId: string): void => {
      if (!allowed(state.consent?.statistics)) {
        return
      }

      const text = `${ns}:${userId}`
      let hash = 2166136261

      // Only compared for equality, so a 32-bit FNV-1a over UTF-16 code units is enough.
      for (let index = 0; index < text.length; index++) {
        hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
      }

      const previous = read("uid", year)

      if (previous && previous !== (hash >>> 0).toString(36)) {
        forget()
      }

      write("uid", (hash >>> 0).toString(36))
    }

    const consent = (answer: boolean | ConsentAnswer): void => {
      const now: ConsentAnswer = (state.consent =
        answer === false ? {} : { ...state.consent, ...(answer === true ? { statistics: true } : answer) })

      // Known before the landing pageview was attempted: the page drew with the answer.
      state.boot ??= state.page ? 0 : 1

      if (!any()) {
        state.user = undefined
        forget()
      }

      if (now.statistics) {
        Object.assign(state.context, {
          locale: navigator.language || undefined,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          screen: [screen.width, screen.height]
        })
        state.mode = "full"

        if (state.user) {
          claim(state.user.id)
        }

        // The landing page was viewed before the answer; without this, consenting on it loses it.
        if (!resent && state.page) {
          resent = true
          core.send("$pageview", undefined, state.page)
        }
      } else {
        if (state.mode === "full") {
          core.clear()
        }

        state.mode = "consentless"
        state.context = { sdk: state.context.sdk }
      }

      core.emit("consent", now)
    }

    state.aid = () => (allowed(any()) ? aid() : undefined)

    core.expose({
      consent,
      identify: (userId: string, traits?: Properties) => {
        if (userId.includes("@")) {
          core.warn("identify(): the id looks like an email")
        }

        claim(userId)
        state.user = { id: userId, traits }
        core.send("$identify", traits)
        core.emit("user")
      },
      reset: () => {
        state.user = undefined
        forget()
        core.emit("user")
      },
      anonymousId: () => (allowed(state.consent?.statistics) ? aid() : undefined)
    })

    const off = core.on("beforeSend", (event) => {
      event.anonymousId = aid()
      event.sessionId = write("sid", read("sid", 18e5) ?? core.uuid())
      event.userId = state.user?.id

      if (event.name === "$pageview" && state.boot) {
        event.properties = { ...event.properties, $boot: 1 }
      }
    })

    const preset = w.__mirafive_consent

    if (preset !== undefined) {
      state.boot = 1
      consent(preset)
    }

    return off
  }
})
