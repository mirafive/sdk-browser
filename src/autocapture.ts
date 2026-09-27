import type { Plugin, Properties } from "./types.ts"

export interface AutocaptureOptions {
  /** More attributes to report in `$el_attrs`, besides data-testid, data-test, data-cy, data-qa and data-track. */
  selectorAttributes?: string[]
}

const roles = "[role=button],[role=link],[role=tab],[role=menuitem]"
const labelled = "a,button," + roles

// Generated names (CSS modules, hashed utilities) change every deploy: a 5+ character part mixing letters and digits.
const stable = (name: string): boolean =>
  !!name && name.length < 25 && !name.split(/[-_]/).some((part) => /^(?=.*\d)(?=.*[a-z]).{5,}$/i.test(part))

const classes = (element: Element): string[] => [...element.classList].filter(stable).slice(0, 3)

const selector = (element: Element | null): string => {
  const parts: string[] = []

  while (element && parts.length < 5 && !element.matches("body,html")) {
    const tag = element.localName
    const { id } = element

    if (stable(id)) {
      parts.unshift(`${tag}#${id}`)
      break
    }

    const same = [...(element.parentElement?.children ?? [])].filter((child) => child.localName === tag)

    parts.unshift(
      tag +
        classes(element)
          .map((name) => "." + name)
          .join("") +
        (same.length > 1 ? `:nth-of-type(${same.indexOf(element) + 1})` : "")
    )
    element = element.parentElement
  }

  return parts.join(" > ")
}

/** `$autocapture` for clicks, submits and changes. Describes elements, never what was typed. */
export const autocapture = ({ selectorAttributes = [] }: AutocaptureOptions = {}): Plugin => ({
  name: "autocapture",
  setup(core) {
    const attributes = ["data-testid", "data-test", "data-cy", "data-qa", "data-track", ...selectorAttributes]
    const types = ["click", "submit", "change"]

    // Capture phase, so a handler calling stopPropagation() does not hide its control.
    const listener = ({ type, target }: Event): void => {
      const element =
        target instanceof Element
          ? type === "submit"
            ? target
            : target.closest("a,button,input,select,textarea," + roles)
          : null

      if (
        !element ||
        element.closest("[data-mira-no-capture]") ||
        (element instanceof HTMLInputElement && /^(password|email|hidden)$/.test(element.type))
      ) {
        return
      }

      const read = (name: string): string | undefined =>
        element.getAttribute(name)?.slice(0, 128) || undefined
      const found: Properties = {}
      const text = element.matches(labelled)
        ? element.textContent?.replace(/\s+/g, " ").trim().slice(0, 128)
        : ""
      const list = classes(element)

      for (const name of attributes) {
        found[name] = read(name)
      }

      core.send(
        "$autocapture",
        {
          $event_type: type,
          $el_tag: element.localName,
          $el_selector: selector(element),
          $el_id: stable(element.id) ? element.id : undefined,
          $el_classes: list.length ? list : undefined,
          $el_text: text || undefined,
          $el_href:
            element instanceof HTMLAnchorElement && /^https?:/.test(element.href)
              ? core.clean(element.href)
              : undefined,
          $el_name: read("name"),
          $el_type: read("type"),
          $el_attrs: Object.values(found).some(Boolean) ? found : undefined
        },
        { url: core.clean(location.href) }
      )
    }

    for (const type of types) {
      document.addEventListener(type, listener, true)
    }

    return () => types.forEach((type) => document.removeEventListener(type, listener, true))
  }
})
