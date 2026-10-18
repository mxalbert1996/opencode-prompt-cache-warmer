import type { Plugin } from "@opencode/plugin"
import { parseOptions } from "./config.js"
import { Warmer } from "./warmer.js"

const ID = "mxalbert.prompt-cache-warmer"

function warn(message: string): void {
  console.warn(`[${ID}] ${message}`)
}

const PARENT_CACHE_LIMIT = 512

class ParentSessions {
  private readonly known = new Map<string, boolean>()

  get(sessionID: string): boolean | undefined {
    return this.known.get(sessionID)
  }

  set(sessionID: string, isChild: boolean): void {
    this.known.delete(sessionID)
    this.known.set(sessionID, isChild)
    if (this.known.size <= PARENT_CACHE_LIMIT) return
    const oldest = this.known.keys().next()
    if (!oldest.done) this.known.delete(oldest.value)
  }

  delete(sessionID: string): void {
    this.known.delete(sessionID)
  }

  clear(): void {
    this.known.clear()
  }
}

function sessionIDOf(event: { readonly data: unknown }): string | undefined {
  const data = event.data as { sessionID?: unknown } | undefined
  return typeof data?.sessionID === "string" ? data.sessionID : undefined
}

export default {
  id: ID,
  async setup(ctx: Plugin.Context): Promise<Plugin.Cleanup | void> {
    const parsed = parseOptions(ctx.options)
    if (!parsed.ok) {
      if (parsed.warning) warn(parsed.warning)
      return
    }

    const warmer = new Warmer({
      ...parsed.settings,
      warn,
      warm: async (sessionID, prompt) => {
        const id = sessionID as Parameters<typeof ctx.session.generate>[0]["sessionID"]
        await ctx.session.generate({ sessionID: id, prompt })
      },
    })
    const controller = new AbortController()
    const parents = new ParentSessions()

    const context = await ctx.session.hook("context", async (event) => {
      const known = parents.get(event.sessionID)
      if (known === undefined) {
        const session = await ctx.session.get({ sessionID: event.sessionID }).catch(() => undefined)
        if (!session) return
        const isChild = session.parentID !== undefined
        parents.set(event.sessionID, isChild)
        if (isChild) return
      } else if (known) {
        return
      }
      warmer.capture(event)
    })
    const generate = await ctx.session.hook("generate", (event) => {
      warmer.replay(event)
    })

    const subscription = (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
          const sessionID = sessionIDOf(event)
          if (event.type === "session.deleted" && sessionID !== undefined) parents.delete(sessionID)
          warmer.handleEvent(event.type, sessionID, (event as { data?: unknown }).data)
        }
      } catch (error) {
        if (!controller.signal.aborted) warn(`event subscription failed: ${String(error)}`)
      }
    })()

    return async () => {
      controller.abort()
      await Promise.all([context.dispose(), generate.dispose()])
      warmer.dispose()
      parents.clear()
      await subscription
    }
  },
} satisfies Plugin.Plugin
