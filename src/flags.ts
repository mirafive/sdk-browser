import { evaluate } from "./protocol/evaluate.ts"
import { fnv1a32 } from "./protocol/hash.ts"
import type { Decision, Facts, Flag, Json, Segments } from "./protocol/types.ts"
import type { FlagBootstrap, FlagState, Globals, Plugin, Properties } from "./types.ts"

export interface FlagsOptions {
  /** Answers until the first fetch; a `<script type="application/json" id="mirafive-flags">` block wins. */
  bootstrap?: FlagBootstrap
  /** Fixed answers for development (mode "full" only), never counted. `true` is "on", `false` is "off". */
  overrides?: Record<string, string | boolean>
  /** Refetch interval while the page is visible. Default 300. */
  refreshSeconds?: number
}

type Answer =
  | readonly [variant: string, value?: Json | undefined, expose?: (() => unknown) | 0 | undefined]
  | undefined

/** Feature flags, remote config and code experiments (FLAGS.md §5). */
export const flags = ({ bootstrap, overrides = {}, refreshSeconds = 300 }: FlagsOptions = {}): Plugin => ({
  name: "flags",
  setup(core) {
    const { state, options } = core
    const w = window as Window & Globals
    const d = document
    const full = options.mode === "full"
    const query = new URLSearchParams(location.search)
    const previews = query.getAll("mirafive-preview")
    const token = query.get("mirafive-preview-token")
    const listeners = new Set<() => void>()
    const frozen: Record<string, Decision> = {}
    let held: Record<string, () => unknown> = {}
    const sent = new Set<string>()
    let current: FlagState = { at: 0 }
    let loaded = false
    let segments: Segments | "pending" | "unavailable" = "unavailable"
    let properties: Properties = {}
    let text: string | undefined
    let href = location.href
    let latest = 0
    let until = 0
    let waiting: ReturnType<typeof setTimeout> | undefined

    const lookup = (): boolean => full && !!state.consent?.targeting && !core.optedOut()

    // One throwing listener must not skip the others, or throw into consent() or identify().
    const call = (listener: () => void): void => {
      try {
        listener()
      } catch (error) {
        core.warn("onFlags listener threw: " + String(error))
      }
    }

    const notify = (): void => {
      if (loaded) {
        state.flags = current

        for (const key of current.orig ?? []) {
          d.documentElement.setAttribute("data-mirafive-" + key, "a")
        }

        core.emit("flags")
        listeners.forEach(call)
      }
    }

    // Segment rules answer "not ready" while a lookup is out, for at most 800 ms.
    const wait = (): void => {
      segments = "pending"
      clearTimeout(waiting)
      waiting = setTimeout(() => {
        if (segments === "pending") {
          segments = "unavailable"
          notify()
        }
      }, 800)
    }

    const load = async (): Promise<void> => {
      if (Date.now() < until) {
        return
      }

      const mine = ++latest
      const post = lookup()

      if (post && typeof segments !== "object") {
        wait()
      }

      href = location.href

      try {
        const response = await fetch(
          `${options.host}/v1/flags/${options.key}` +
            (full ? (token ? "?mirafive-preview-token=" + encodeURIComponent(token) : "") : "?view=values"),
          {
            method: post ? "POST" : "GET",
            body: post ? JSON.stringify({ anonymousId: state.aid?.(), identified: !!state.user }) : null,
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer"
          }
        )

        if (response.status === 429) {
          until = Date.now() + (+(response.headers.get("retry-after") ?? 0) * 1e3 || 3e5)
        }

        const body = await response.text()
        const parsed: FlagState & {
          document?: FlagState
          membership?: { segments: string[]; unavailable: string[] }
        } = JSON.parse(body)
        const next = parsed.document ?? parsed
        // A new compile time alone is no change for listeners.
        const content = body.replace(/"at":\d+/g, "")

        if (!response.ok || mine !== latest || next.v !== 1) {
          return
        }

        if (post) {
          const { membership } = parsed

          segments = membership
            ? { in: membership.segments, unavailable: membership.unavailable }
            : "unavailable"
        }

        current = next
        loaded = true

        if (content !== text || post) {
          text = content
          notify()
        }
      } catch {
        // The last flags stay in use.
      }
    }

    const refresh = (): void => {
      if (d.visibilityState === "visible") {
        void load()
      }
    }

    const facts = (flag: Flag): Facts => {
      const consent = state.consent
      const early = flag.e === "r" && !consent
      const allowed = !core.optedOut() && (!flag.e || consent?.experiments || early)
      const page = new URLSearchParams(location.search)
      const utm = (name: string): [string, string | null] => ["$utm_" + name, page.get("utm_" + name)]
      let referrer: string | null = null

      try {
        referrer = new URL(d.referrer).hostname
      } catch {
        // No referrer.
      }

      return {
        id: allowed
          ? consent?.experiments
            ? state.aid?.()
            : early
              ? (w.__mirafive_aid_next ||= core.uuid())
              : undefined
          : undefined,
        userId: allowed ? state.user?.id : undefined,
        properties: {
          ...Object.fromEntries(["source", "medium", "campaign"].map(utm)),
          $referrer_host: referrer,
          ...state.user?.traits,
          ...properties
        },
        segments: lookup() ? segments : "unavailable"
      }
    }

    // Exposures wait for the experiments scope and are sent at most once per flag and page load.
    const drain = (): void => {
      if (state.consent?.experiments && state.mode === "full" && !core.optedOut()) {
        for (const key in held) {
          // Marked sent only once sent: a check that fails now (the user not identified yet) may pass later.
          if (held[key]?.()) {
            sent.add(key)
            delete held[key]
          }
        }
      }
    }

    const expose = (key: string, variant: string): true => {
      core.send("$exposure", { $experiment: key, $variant: variant, $boot: state.boot ?? 0 })
      return true
    }

    const answer = (key: string): Answer => {
      const flag = current.flags?.[key]
      const entry = w.__mirafive_experiments?.find((candidate) => candidate.k === key)
      const override = full ? overrides[key] : undefined
      const preview = previews.find((candidate) => candidate.startsWith(key + ":"))?.slice(key.length + 1)
      const pick = (variant: string): Answer => [variant, flag?.p?.[variant]]

      if (override !== undefined) {
        return pick(override === true ? "on" : override === false ? "off" : override)
      }

      if (
        preview &&
        (entry
          ? ["a", "b"]
          : flag
            ? flag.t === "b"
              ? ["on", "off"]
              : [
                  flag.d,
                  ...Object.keys(flag.p ?? {}),
                  ...flag.r.flatMap((rule) =>
                    "x" in rule ? rule.x : (rule.w ?? []).map((weight) => weight[0])
                  )
                ]
            : []
        ).includes(preview)
      ) {
        return pick(preview)
      }

      if (current.orig?.includes(key)) {
        return ["a"]
      }

      if (entry) {
        return [entry.v]
      }

      if (!flag) {
        const value = current.values?.[key]

        if (!value) {
          return undefined
        }

        // What the page read stays, so a later document cannot switch an experiment mid-page.
        const kept = (frozen[key] ??= { variant: value[0], reason: value[2] ? "SPLIT" : "STATIC" })
        const variant = kept.reason === "SPLIT" ? kept.variant : value[0]
        const { unit } = current

        // A server-decided experiment counts only for the user it was decided for.
        return [
          variant,
          variant === value[0] ? value[1] : undefined,
          value[2] && (() => unit === String(fnv1a32(state.user?.id ?? "")) && expose(key, variant))
        ]
      }

      let decision = evaluate(flag, facts(flag))

      if (!("variant" in decision)) {
        return undefined
      }

      // An experiment keeps the variant this page first showed, unless it is turned off.
      if (flag.e && decision.reason !== "DISABLED") {
        decision = frozen[key] ??= decision
      }

      const { variant, reason } = decision

      return [
        variant,
        flag.p?.[variant],
        flag.e && flag.c === "b" && reason === "SPLIT"
          ? () => {
              // Sent only when the id it is counted under still gives the variant shown.
              const again = evaluate(flag, facts(flag))

              return (
                "variant" in again &&
                again.variant === variant &&
                again.reason === reason &&
                expose(key, variant)
              )
            }
          : undefined
      ]
    }

    const read = (key: string, fallback: unknown, config?: boolean): unknown => {
      const found = answer(key)

      if (!found) {
        if (loaded && !current.flags?.[key] && !current.values?.[key]) {
          core.warn(`flag "${key}" is unknown`)
        }

        return fallback
      }

      if (found[2] && !sent.has(key)) {
        held[key] ??= found[2]
        drain()
      }

      return config ? (found[1] ?? fallback) : found[0] === "on" || (found[0] !== "off" && found[0])
    }

    core.expose({
      flag: (key: string, fallback: string | boolean) => read(key, fallback),
      config: (key: string, fallback: unknown) => read(key, fallback, true),
      onFlags: (listener: () => void) => {
        listeners.add(listener)

        if (loaded) {
          call(listener)
        }

        return () => listeners.delete(listener)
      },
      setFlagProperties: (given: Properties) => {
        properties = given
        notify()
      }
    })

    let block: FlagState | undefined

    try {
      block = JSON.parse(d.getElementById("mirafive-flags")?.textContent ?? "")
    } catch {
      // No block.
    }

    const initial = [block, bootstrap].find(
      (candidate) => candidate?.v === 1 && Date.now() - candidate.at < 6048e5
    )

    if (initial) {
      current = initial
      loaded = true
      notify()
    }

    if (!initial || Date.now() - initial.at > 6e4 || initial.browser?.length) {
      void load()
    }

    const timer = setInterval(refresh, refreshSeconds * 1e3)
    const offs = [
      core.on("pageview", () => {
        if (location.href !== href) {
          void load()
        }
      }),
      core.on("consent", (consent) => {
        if (lookup() && typeof segments !== "object") {
          void load()
        }

        if (!consent.experiments) {
          held = {}
        }

        drain()
        notify()
      }),
      core.on("user", () => {
        drain()

        // Membership may differ for the signed-in person.
        if (lookup()) {
          void load()
        }

        notify()
      }),
      () => {
        clearInterval(timer)
        clearTimeout(waiting)
        d.removeEventListener("visibilitychange", refresh)
      }
    ]

    d.addEventListener("visibilitychange", refresh)

    return () => offs.forEach((off) => off())
  }
})
