import { describe, expect, it } from "vitest"

import { autocapture } from "../src/autocapture.ts"
import { identity } from "../src/identity.ts"
import { events, mira, requests } from "./helpers.ts"

const html = (markup: string): void => {
  document.body.innerHTML = markup
}

const click = (selector: string): void => {
  document.querySelector(selector)?.dispatchEvent(new MouseEvent("click", { bubbles: true }))
}

const captured = async (client: { flush(): Promise<void> }): Promise<Record<string, unknown>[]> => {
  await client.flush()
  return events().map((event) => event.properties ?? {})
}

describe("autocapture()", () => {
  it("describes a clicked button, even inside a label span", async () => {
    html(`<main><form id="checkout"><button class="primary btn_x1f2a9 large" type="submit" data-testid="buy">
      <span>Jetzt  kaufen</span></button></form></main>`)
    const client = await mira({ plugins: [autocapture()] })

    click("span")

    expect(await captured(client)).toEqual([
      {
        $event_type: "click",
        $el_tag: "button",
        $el_selector: "form#checkout > button.primary.large",
        $el_classes: ["primary", "large"],
        $el_text: "Jetzt kaufen",
        $el_type: "submit",
        $el_attrs: { "data-testid": "buy" }
      }
    ])
    expect(events()[0]?.page).toEqual({ url: "https://shop.example/pricing?utm_source=news" })
  })

  it("adds :nth-of-type among same-tag siblings and stops after 5 segments", async () => {
    html(
      `<div><div><section><ul><li><a>One</a></li><li><a href="/two?ref=nav&session=1#x">Two</a></li></ul></section></div></div>`
    )
    const client = await mira({ plugins: [autocapture()] })

    click("li:nth-of-type(2) a")

    expect(await captured(client)).toEqual([
      {
        $event_type: "click",
        $el_tag: "a",
        $el_selector: "div > section > ul > li:nth-of-type(2) > a",
        $el_text: "Two",
        $el_href: "https://shop.example/two?ref=nav"
      }
    ])
  })

  it("keeps stable ids and skips generated ones", async () => {
    html(`<div id="css-1a2b3c4"><button id="save">Save</button><button id="r4nd0mx">Go</button></div>`)
    const client = await mira({ plugins: [autocapture()] })

    click("#save")
    click("#r4nd0mx")

    const [save, go] = await captured(client)

    expect(save).toMatchObject({ $el_selector: "button#save", $el_id: "save" })
    expect(go).toMatchObject({ $el_selector: "div > button:nth-of-type(2)" })
    expect(go).not.toHaveProperty("$el_id")
  })

  it("resolves roles and ignores plain elements", async () => {
    html(`<div role="tab">Plans</div><p>Just text</p>`)
    const client = await mira({ plugins: [autocapture()] })

    click("p")
    click("[role=tab]")

    expect(await captured(client)).toEqual([
      { $event_type: "click", $el_tag: "div", $el_selector: "div", $el_text: "Plans" }
    ])
  })

  it("reports submits and changes, never values or text of fields", async () => {
    html(
      `<form class="search"><input name="q" type="search" value="secret"><select name="size"><option>M</option></select></form>`
    )
    const client = await mira({ plugins: [autocapture()] })

    document.querySelector("input")?.dispatchEvent(new Event("change", { bubbles: true }))
    document.querySelector("select")?.dispatchEvent(new Event("change", { bubbles: true }))
    document.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }))

    expect(await captured(client)).toEqual([
      {
        $event_type: "change",
        $el_tag: "input",
        $el_selector: "form.search > input",
        $el_name: "q",
        $el_type: "search"
      },
      { $event_type: "change", $el_tag: "select", $el_selector: "form.search > select", $el_name: "size" },
      { $event_type: "submit", $el_tag: "form", $el_selector: "form.search", $el_classes: ["search"] }
    ])
    expect(JSON.stringify(events())).not.toContain("secret")
  })

  it.each(["password", "email", "hidden"])("sends nothing for %s inputs", async (type) => {
    html(`<input type="${type}" name="x">`)
    const client = await mira({ plugins: [autocapture()] })

    document.querySelector("input")?.dispatchEvent(new Event("change", { bubbles: true }))
    click("input")
    await client.flush()

    expect(requests).toHaveLength(0)
  })

  it("sends nothing under [data-mira-no-capture]", async () => {
    html(`<div data-mira-no-capture><button>Pay</button></div>`)
    const client = await mira({ plugins: [autocapture()] })

    click("button")
    await client.flush()

    expect(requests).toHaveLength(0)
  })

  it("skips mailto, tel and javascript links' addresses", async () => {
    html(`<a href="mailto:ada@example.com">Mail</a>`)
    const client = await mira({ plugins: [autocapture()] })

    click("a")

    expect((await captured(client))[0]).not.toHaveProperty("$el_href")
  })

  it("reports selectorAttributes and truncates text to 128 characters", async () => {
    html(`<button data-track="cta" aria-label="Buy now">${"x".repeat(200)}</button>`)
    const client = await mira({ plugins: [autocapture({ selectorAttributes: ["aria-label"] })] })

    click("button")

    const [properties] = await captured(client)

    expect(properties?.["$el_attrs"]).toEqual({ "data-track": "cta", "aria-label": "Buy now" })
    expect(properties?.["$el_text"]).toHaveLength(128)
  })

  it("captures in the capture phase, before stopPropagation()", async () => {
    html(`<div><button>Menu</button></div>`)
    document.querySelector("div")?.addEventListener("click", (event) => event.stopPropagation())
    const client = await mira({ plugins: [autocapture()] })

    click("button")

    expect(await captured(client)).toHaveLength(1)
  })

  it("waits for consent in mode full", async () => {
    html(`<button>Buy</button>`)
    const client = await mira({ mode: "full", plugins: [identity(), autocapture()] })

    click("button")
    client.consent(true)
    click("button")
    await client.flush()

    expect(events().map((event) => event.name)).toEqual(["$autocapture"])
    expect(events()[0]?.anonymousId).toBeDefined()
  })

  it("stops on destroy", async () => {
    html(`<button>Buy</button>`)
    const client = await mira({ plugins: [autocapture()] })

    client.destroy()
    click("button")
    await client.flush()

    expect(requests).toHaveLength(0)
  })
})

describe("review fixes", () => {
  it("never splits a surrogate pair when cutting text or attributes", async () => {
    html(`<button data-track="${"x".repeat(127)}😀">${"y".repeat(127)}😀</button>`)
    const client = await mira({ plugins: [autocapture()] })

    click("button")

    const [properties] = await captured(client)

    expect(properties?.["$el_text"]).toBe("y".repeat(127))
    expect(properties?.["$el_attrs"]).toEqual({ "data-track": "x".repeat(127) })
    expect(requests[0]?.body).not.toMatch(/\\ud[89a-f]/)
  })
})
