import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "./index.js"
import { DEFAULT_PROMPT } from "./config.js"

type Handler = (event: never) => unknown

interface Fake {
  ctx: Plugin.Context
  hooks: Map<string, Handler>
  warmed: string[]
  disposed: string[]
  sessions: Map<string, { parentID?: string }>
  lookups: string[]
  emit: (event: { type: string; data: unknown }) => void
}

function fake(options: Record<string, unknown> = { interval: "1h" }): Fake {
  const hooks = new Map<string, Handler>()
  const warmed: string[] = []
  const disposed: string[] = []
  const sessions = new Map<string, { parentID?: string }>()
  const lookups: string[] = []
  const queue: Array<{ type: string; data: unknown }> = []

  const ctx = {
    options,
    session: {
      hook: async (name: string, handler: Handler) => {
        hooks.set(name, handler)
        return {
          dispose: async () => {
            disposed.push(name)
            hooks.delete(name)
          },
        }
      },
      get: async ({ sessionID }: { sessionID: string }) => {
        lookups.push(sessionID)
        const session = sessions.get(sessionID)
        if (!session) throw new Error("not found")
        return session
      },
      generate: async ({ prompt }: { prompt: string }) => {
        warmed.push(prompt)
        return { text: "OK" }
      },
    },
    event: {
      subscribe: (options?: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (options?.signal?.aborted) return
            const next = queue.shift()
            if (next) {
              yield next
              continue
            }
            await new Promise((resolve) => setTimeout(resolve, 1))
          }
        },
      }),
    },
  } as unknown as Plugin.Context

  return {
    ctx,
    hooks,
    warmed,
    disposed,
    sessions,
    lookups,
    emit: (event) => {
      queue.push(event)
    },
  }
}

const model = { providerID: "anthropic", id: "claude-sonnet-5" }

function contextEvent(sessionID: string) {
  return {
    sessionID,
    model,
    agent: "build",
    system: [{ type: "text", text: "system" }],
    messages: [],
    options: {},
    tools: {},
  }
}

describe("plugin entry", () => {
  test("registers context and generate hooks and warms a parent session", async () => {
    const f = fake({ interval: "10ms", duration: "1h" })
    f.sessions.set("ses_a", {})
    const cleanup = await plugin.setup(f.ctx)
    expect(typeof cleanup).toBe("function")
    expect([...f.hooks.keys()].sort()).toEqual(["context", "generate"])

    await (f.hooks.get("context") as (event: unknown) => Promise<void>)(contextEvent("ses_a"))
    await Bun.sleep(60)

    expect(f.warmed.length).toBeGreaterThanOrEqual(1)
    expect(f.warmed[0]).toBe(DEFAULT_PROMPT)
    await cleanup?.()
  })

  test("skips subagent sessions without warming them", async () => {
    const f = fake({ interval: "10ms", duration: "1h" })
    f.sessions.set("ses_sub", { parentID: "ses_parent" })
    const cleanup = await plugin.setup(f.ctx)

    const context = f.hooks.get("context") as (event: unknown) => Promise<void>
    await context(contextEvent("ses_sub"))
    await Bun.sleep(40)

    expect(f.warmed).toEqual([])
    expect(f.lookups).toEqual(["ses_sub"])
    await cleanup?.()
  })

  test("tolerates a session the host cannot resolve", async () => {
    const f = fake({ interval: "10ms" })
    const cleanup = await plugin.setup(f.ctx)
    await (f.hooks.get("context") as (event: unknown) => Promise<void>)(contextEvent("ses_missing"))
    await Bun.sleep(30)
    expect(f.warmed).toEqual([])
    await cleanup?.()
  })

  test("resolves the session once and reuses the answer", async () => {
    const f = fake({ interval: "1h" })
    f.sessions.set("ses_a", {})
    const cleanup = await plugin.setup(f.ctx)
    const context = f.hooks.get("context") as (event: unknown) => Promise<void>
    await context(contextEvent("ses_a"))
    await context(contextEvent("ses_a"))
    await context(contextEvent("ses_a"))
    expect(f.lookups).toEqual(["ses_a"])
    await cleanup?.()
  })

  test("forgets a deleted session", async () => {
    const f = fake({ interval: "1h" })
    f.sessions.set("ses_a", {})
    const cleanup = await plugin.setup(f.ctx)
    const context = f.hooks.get("context") as (event: unknown) => Promise<void>
    await context(contextEvent("ses_a"))
    f.emit({ type: "session.deleted", data: { sessionID: "ses_a" } })
    await Bun.sleep(20)
    await context(contextEvent("ses_a"))
    expect(f.lookups).toEqual(["ses_a", "ses_a"])
    await cleanup?.()
  })

  test("drops the snapshot and its timer when an invalidation event arrives", async () => {
    const f = fake({ interval: "50ms", duration: "1h" })
    f.sessions.set("ses_a", {})
    const cleanup = await plugin.setup(f.ctx)
    await (f.hooks.get("context") as (event: unknown) => Promise<void>)(contextEvent("ses_a"))

    f.emit({ type: "session.compaction.ended", data: { sessionID: "ses_a" } })
    await Bun.sleep(120)

    expect(f.warmed).toEqual([])
    await cleanup?.()
  })

  test("does nothing when disabled", async () => {
    const f = fake({ enabled: false })
    const cleanup = await plugin.setup(f.ctx)
    expect(cleanup).toBeUndefined()
    expect(f.hooks.size).toBe(0)
  })

  test("disables itself and warns on an invalid duration", async () => {
    const warnings: unknown[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(" "))
    }
    try {
      const f = fake({ interval: "abc" })
      const cleanup = await plugin.setup(f.ctx)
      expect(cleanup).toBeUndefined()
      expect(f.hooks.size).toBe(0)
      expect(String(warnings[0])).toContain("interval")
    } finally {
      console.warn = original
    }
  })

  test("cleanup disposes hooks and stops the event subscription", async () => {
    const f = fake({ interval: "10ms" })
    f.sessions.set("ses_a", {})
    const cleanup = await plugin.setup(f.ctx)
    await (f.hooks.get("context") as (event: unknown) => Promise<void>)(contextEvent("ses_a"))

    await cleanup?.()
    expect(f.disposed.sort()).toEqual(["context", "generate"])

    const warmedBefore = f.warmed.length
    await Bun.sleep(40)
    expect(f.warmed.length).toBe(warmedBefore)
  })
})
