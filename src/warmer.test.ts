import { describe, expect, test } from "bun:test"
import { DEFAULT_DURATION, DEFAULT_INTERVAL, DEFAULT_PROMPT, parseDuration, parseModelRules, parseOptions } from "./config.js"
import type { ContextEvent, GenerateEvent, ModelRule } from "./warmer.js"
import { Warmer, invalidatesTranscript, modelKey, shouldWarm } from "./warmer.js"

const model = { providerID: "anthropic", id: "claude-sonnet-5" } as const

function message(text: string) {
  return { role: "user" as const, content: [{ type: "text" as const, text }] }
}

function contextEvent(overrides: Partial<ContextEvent> = {}): ContextEvent {
  return {
    sessionID: "ses_test" as ContextEvent["sessionID"],
    model,
    agent: "build" as ContextEvent["agent"],
    system: [{ type: "text", text: "You are OpenCode." }],
    messages: [message("first"), message("second")],
    options: { maxTokens: 1000 },
    tools: { bash: { description: "Run a command", input: {} } },
    ...overrides,
  } as ContextEvent
}

function generateEvent(overrides: Partial<GenerateEvent> = {}): GenerateEvent {
  return {
    sessionID: "ses_test" as ContextEvent["sessionID"],
    model,
    agent: "build" as ContextEvent["agent"],
    system: [],
    messages: [message(DEFAULT_PROMPT)],
    options: {},
    tools: { bash: { description: "generate default", input: {} } },
    ...overrides,
  } as GenerateEvent
}

interface Harness {
  instance: Warmer
  calls: Array<{ sessionID: string; prompt: string }>
  inFlight: (event: GenerateEvent) => Promise<void>
}

function harness(
  overrides: Partial<{
    interval: number
    duration: number
    models: readonly ModelRule[]
    now: () => number
    warm: () => Promise<void>
  }> = {},
): Harness {
  const calls: Array<{ sessionID: string; prompt: string }> = []
  let queued: GenerateEvent | undefined
  const result: Harness = {
    instance: undefined as unknown as Warmer,
    calls,
    inFlight: async (event) => {
      queued = event
      try {
        await result.instance.warm(String(event.sessionID))
      } finally {
        queued = undefined
      }
    },
  }
  result.instance = new Warmer({
    prompt: DEFAULT_PROMPT,
    interval: overrides.interval ?? 60_000,
    duration: overrides.duration ?? DEFAULT_DURATION,
    models: overrides.models,
    warm: async (sessionID, prompt) => {
      calls.push({ sessionID, prompt })
      if (queued) result.instance.replay(queued)
      await overrides.warm?.()
    },
    now: overrides.now,
    warn: () => {},
  })
  return result
}

describe("capture and replay", () => {
  test("replaces the whole request and appends the keep-alive last", async () => {
    const { instance, inFlight } = harness()
    const context = contextEvent()
    instance.capture(context)

    const tail = message(DEFAULT_PROMPT)
    const event = generateEvent({ messages: [message("history from session"), tail] })
    await inFlight(event)

    expect(event.system).toEqual(context.system)
    expect(event.messages).toEqual([...context.messages, tail])
    expect(event.messages.at(-1)).toBe(tail)
    expect(event.messages.at(-2)).toBe(context.messages[1])
    expect(event.system[0]).toBe(context.system[0])
    expect(event.options).toEqual(context.options)
    expect(event.tools.bash?.description).toBe("Run a command")
    instance.dispose()
  })

  test("restores tool fields by key", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent())
    const definition = { description: "", input: {} }
    const event = generateEvent({ tools: { bash: definition } })
    await inFlight(event)
    expect(event.tools.bash).toBe(definition)
    expect(definition.description).toBe("Run a command")
    instance.dispose()
  })

  test("cannot restore a tool that a context hook renamed", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent({ tools: { editor: { description: "edited", input: {} } } as ContextEvent["tools"] }))
    const definition = { description: "generate default", input: {} }
    const event = generateEvent({ tools: { bash: definition } })
    await inFlight(event)
    expect(definition.description).toBe("generate default")
    instance.dispose()
  })

  test("leaves the tool set untouched when a key is missing from the snapshot", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent())
    const added = { description: "added by generate", input: {} }
    const event = generateEvent({ tools: { added } })
    await inFlight(event)
    expect(added.description).toBe("added by generate")
    instance.dispose()
  })

  test("applies no partial mutation when a same-count key is missing", async () => {
    const { instance, inFlight } = harness()
    const captured = { a: { description: "captured a", input: {} }, b: { description: "captured b", input: {} } }
    instance.capture(contextEvent({ tools: captured as unknown as ContextEvent["tools"] }))
    const a = { description: "current a", input: {} }
    const c = { description: "current c", input: {} }
    const event = generateEvent({ tools: { a, c } as unknown as GenerateEvent["tools"] })
    await inFlight(event)
    expect(a.description).toBe("current a")
    expect(c.description).toBe("current c")
    instance.dispose()
  })

  test("leaves the tool set untouched when the snapshot has more tools", async () => {
    const { instance, inFlight } = harness()
    const captured = { a: { description: "captured a", input: {} }, b: { description: "captured b", input: {} } }
    instance.capture(contextEvent({ tools: captured as unknown as ContextEvent["tools"] }))
    const a = { description: "current a", input: {} }
    const event = generateEvent({ tools: { a } as unknown as GenerateEvent["tools"] })
    await inFlight(event)
    expect(a.description).toBe("current a")
    instance.dispose()
  })

  test("leaves a generate event untouched when nothing is pending", () => {
    const { instance } = harness()
    instance.capture(contextEvent())
    const event = generateEvent()
    const before = structuredClone(event)
    instance.replay(event)
    expect(event).toEqual(before)
    instance.dispose()
  })
})

describe("gating", () => {
  test("replays while a warm call is in flight", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent())
    const event = generateEvent()
    await inFlight(event)
    expect(event.messages).toHaveLength(3)
    instance.dispose()
  })

  test("skips a generate event started outside the plugin", async () => {
    const { instance, calls } = harness()
    instance.capture(contextEvent())
    const event = generateEvent()
    const before = structuredClone(event)
    instance.replay(event)
    expect(event).toEqual(before)
    expect(calls).toEqual([])
    instance.dispose()
  })

  test("skips a concurrent generate call carrying a different prompt", async () => {
    const { instance } = harness()
    instance.capture(contextEvent())
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const warm = instance.warm("ses_test")
    const foreign = generateEvent({ messages: [message("summarize this file")] })
    const before = structuredClone(foreign)
    instance.replay(foreign)
    expect(foreign).toEqual(before)
    release()
    await held
    await warm
    instance.dispose()
  })

  test("replays its own request while a warm is in flight", async () => {
    const { instance } = harness()
    instance.capture(contextEvent())
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const warm = instance.warm("ses_test")
    const own = generateEvent()
    instance.replay(own)
    expect(own.messages).toHaveLength(3)
    release()
    await held
    await warm
    instance.dispose()
  })

  test("does not transform the following event after a warm call fails", async () => {
    const { instance, inFlight } = harness({
      warm: async () => {
        throw new Error("provider unavailable")
      },
    })
    instance.capture(contextEvent())
    const failed = generateEvent()
    await expect(inFlight(failed)).rejects.toThrow("provider unavailable")
    expect(failed.messages).toHaveLength(3)

    const next = generateEvent()
    const before = structuredClone(next)
    instance.replay(next)
    expect(next).toEqual(before)
    instance.dispose()
  })
})

describe("identity checks", () => {
  test("skips a snapshot captured for another model", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent())
    const event = generateEvent({ model: { providerID: "anthropic", id: "other-model" } as GenerateEvent["model"] })
    const before = structuredClone(event)
    await inFlight(event)
    expect(event).toEqual(before)
    instance.dispose()
  })

  test("skips a snapshot whose model variant changed", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent({ model: { ...model, variant: "high" } as ContextEvent["model"] }))
    const event = generateEvent()
    const before = structuredClone(event)
    await inFlight(event)
    expect(event).toEqual(before)
    instance.dispose()
  })

  test("skips a snapshot captured for another agent", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent())
    const event = generateEvent({ agent: "plan" as GenerateEvent["agent"] })
    const before = structuredClone(event)
    await inFlight(event)
    expect(event).toEqual(before)
    instance.dispose()
  })

  test("model keys include the variant", () => {
    expect(modelKey({ ...model } as ContextEvent["model"])).toBe("anthropic/claude-sonnet-5#")
    expect(modelKey({ ...model, variant: "high" } as ContextEvent["model"])).toBe("anthropic/claude-sonnet-5#high")
  })
})

describe("model rules", () => {
  const rule = (pattern: string, exclude = false): ModelRule => ({ pattern, exclude })
  const ref = (providerID: string, id: string, variant?: string) =>
    ({ providerID, id, variant }) as unknown as ContextEvent["model"]
  const base = ref("anthropic", "claude-sonnet-5")

  test("warms everything when no rules are configured", () => {
    expect(shouldWarm(base, undefined)).toBe(true)
    expect(shouldWarm(base, [])).toBe(true)
  })

  test("matches on the full key, the provider-qualified id, and the bare id", () => {
    expect(shouldWarm(base, [rule("anthropic/claude-sonnet-5#")])).toBe(true)
    expect(shouldWarm(base, [rule("anthropic/claude-sonnet-5")])).toBe(true)
    expect(shouldWarm(base, [rule("claude-sonnet-5")])).toBe(true)
    expect(shouldWarm(base, [rule("claude-sonnet-5#high")])).toBe(false)
  })

  test("distinguishes variants", () => {
    const high = ref("anthropic", "claude-sonnet-5", "high")
    expect(shouldWarm(high, [rule("anthropic/claude-sonnet-5#high")])).toBe(true)
    expect(shouldWarm(high, [rule("anthropic/claude-sonnet-5#")])).toBe(false)
  })

  test("supports wildcards and ignores case", () => {
    expect(shouldWarm(base, [rule("anthropic/*")])).toBe(true)
    expect(shouldWarm(base, [rule("*claude*")])).toBe(true)
    expect(shouldWarm(base, [rule("ANTHROPIC/claude-sonnet-5")])).toBe(true)
    expect(shouldWarm(base, [rule("anthropic/claude-sonnet-?")])).toBe(true)
    expect(shouldWarm(base, [rule("google/*")])).toBe(false)
  })

  test("treats a dot in a pattern literally", () => {
    expect(shouldWarm(base, [rule("anthropic/claude.sonnet.4")])).toBe(false)
  })

  test("treats other regex metacharacters literally without throwing", () => {
    for (const pattern of ["[", "{", "(", "\\", "$^", "a+b", "{2,3}", "|", ")?("]) {
      expect(() => shouldWarm(base, [rule(pattern)])).not.toThrow()
      expect(shouldWarm(base, [rule(pattern)])).toBe(false)
    }
    expect(shouldWarm(ref("anthropic", "a+b"), [rule("anthropic/a+b")])).toBe(true)
  })

  test("only warms models an include rule matches", () => {
    const rules = [rule("anthropic/*")]
    expect(shouldWarm(base, rules)).toBe(true)
    expect(shouldWarm(ref("other", "m"), rules)).toBe(false)
  })

  test("warms everything except excluded models", () => {
    const rules = [rule("anthropic/claude-sonnet-5", true)]
    expect(shouldWarm(base, rules)).toBe(false)
    expect(shouldWarm(ref("anthropic", "claude-haiku"), rules)).toBe(true)
  })

  test("lets an exclusion win over an include", () => {
    const rules = [rule("anthropic/*"), rule("anthropic/claude-sonnet-5", true)]
    expect(shouldWarm(base, rules)).toBe(false)
  })

  test("does not capture a session on an excluded model", () => {
    const { instance } = harness({ models: [rule("anthropic/claude-sonnet-5", true)] })
    instance.capture(contextEvent())
    expect(instance.has("ses_test")).toBe(false)
    instance.dispose()
  })

  test("stops warming a session that switches to an excluded model", async () => {
    const { instance, inFlight } = harness({ models: [rule("anthropic/claude-sonnet-5", true)] })
    instance.capture(contextEvent({ model: ref("anthropic", "claude-haiku") }))
    expect(instance.has("ses_test")).toBe(true)
    instance.capture(contextEvent())
    expect(instance.has("ses_test")).toBe(false)

    const event = generateEvent()
    await inFlight(event)
    expect(event.messages).toHaveLength(1)
    instance.dispose()
  })
})

describe("expiry", () => {
  test("skips a snapshot older than the configured duration", async () => {
    let clock = 1_000
    const { instance, inFlight } = harness({ now: () => clock, duration: 10_000 })
    instance.capture(contextEvent())
    clock += 10_001

    const event = generateEvent()
    const before = structuredClone(event)
    await inFlight(event)
    expect(event).toEqual(before)
    instance.dispose()
  })

  test("replays a snapshot just under the duration boundary", async () => {
    let clock = 1_000
    const { instance, inFlight } = harness({ now: () => clock, duration: 10_000 })
    instance.capture(contextEvent())
    clock += 9_999

    const event = generateEvent()
    await inFlight(event)
    expect(event.messages).toHaveLength(3)
    instance.dispose()
  })

  test("skips a snapshot exactly at the duration boundary", async () => {
    let clock = 1_000
    const { instance, inFlight } = harness({ now: () => clock, duration: 10_000 })
    instance.capture(contextEvent())
    clock += 10_000

    const event = generateEvent()
    await inFlight(event)
    expect(event.messages).toHaveLength(1)
    instance.dispose()
  })
})

describe("invalidation", () => {
  test("drops the snapshot after compaction ends", async () => {
    const { instance, inFlight } = harness()
    const event = contextEvent()
    instance.capture(event)
    instance.handleEvent("session.compaction.ended", String(event.sessionID))

    const generate = generateEvent()
    const before = structuredClone(generate)
    await inFlight(generate)
    expect(generate).toEqual(before)
    instance.dispose()
  })

  test("ignores unrelated events", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent())
    instance.handleEvent("session.usage.updated", "ses_test")

    const generate = generateEvent()
    await inFlight(generate)
    expect(generate.messages).toHaveLength(3)
    instance.dispose()
  })

  test("recognizes every transcript-changing event", () => {
    for (const type of [
      "session.compaction.started",
      "session.compaction.ended",
      "session.compaction.failed",
      "session.revert.staged",
      "session.revert.cleared",
      "session.revert.committed",
      "session.agent.selected",
      "session.model.selected",
      "session.instructions.updated",
      "session.message.content.updated",
      "session.skill.activated",
      "session.shell.ended",
      "session.synthetic",
      "session.deleted",
      "session.moved",
      "session.forked",
    ]) {
      expect(invalidatesTranscript(type)).toBe(true)
    }
    expect(invalidatesTranscript("session.created")).toBe(false)
  })

  test("ignores a background shell completion", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent())
    instance.handleEvent("session.shell.ended", "ses_test", {
      shell: { id: "sh_1", metadata: { background: true } },
    })
    const event = generateEvent()
    await inFlight(event)
    expect(event.messages).toHaveLength(3)
    instance.dispose()
  })

  test("drops the snapshot when a foreground shell completes", async () => {
    const { instance, inFlight } = harness()
    instance.capture(contextEvent())
    instance.handleEvent("session.shell.ended", "ses_test", { shell: { id: "sh_1", metadata: {} } })
    const event = generateEvent()
    await inFlight(event)
    expect(event.messages).toHaveLength(1)
    instance.dispose()
  })
})

describe("scheduling", () => {
  test("warms after the interval and re-arms", async () => {
    const { instance, calls } = harness({ interval: 5 })
    instance.capture(contextEvent())
    await Bun.sleep(30)
    expect(calls.length).toBeGreaterThanOrEqual(2)
    expect(calls[0]?.prompt).toBe(DEFAULT_PROMPT)
    instance.dispose()
  })

  test("drops an idle session instead of warming past the duration", async () => {
    let clock = 0
    const { instance, calls } = harness({ now: () => clock, interval: 5, duration: 10 })
    instance.capture(contextEvent())
    clock = 11
    await Bun.sleep(25)
    expect(calls).toEqual([])
    instance.dispose()
  })

  test("expires at the duration even when the interval is longer", async () => {
    let clock = 0
    const { instance, calls } = harness({ now: () => clock, interval: 60_000, duration: 20 })
    instance.capture(contextEvent())
    clock = 25
    await Bun.sleep(40)
    expect(calls).toEqual([])
    expect(instance.has("ses_test")).toBe(false)
    instance.dispose()
  })

  test("replaces the timer when activity arrives again", async () => {
    const { instance, calls } = harness({ interval: 30 })
    instance.capture(contextEvent())
    instance.capture(contextEvent())
    await Bun.sleep(40)
    expect(calls).toHaveLength(1)
    instance.dispose()
  })

  test("cleanup stops all timers", async () => {
    const { instance, calls } = harness({ interval: 5 })
    instance.capture(contextEvent())
    instance.dispose()
    await Bun.sleep(25)
    expect(calls).toEqual([])
  })
})

describe("config", () => {
  test("parses the documented duration forms", () => {
    expect(parseDuration("4 minutes")).toBe(240_000)
    expect(parseDuration("4m")).toBe(240_000)
    expect(parseDuration("30 minutes")).toBe(1_800_000)
    expect(parseDuration("1 hour")).toBe(3_600_000)
    expect(parseDuration("90s")).toBe(90_000)
    expect(parseDuration(240_000)).toBe(240_000)
    expect(parseDuration("240000")).toBe(240_000)
  })

  test("rejects non-positive and malformed durations", () => {
    expect(parseOptions({ interval: "0" }).ok).toBe(false)
    expect(parseOptions({ duration: "0" }).ok).toBe(false)
    expect(parseOptions({ duration: "abc" }).ok).toBe(false)
    expect(parseDuration("-4m")).toBeUndefined()
    expect(parseDuration("4 parsecs")).toBeUndefined()
    expect(parseDuration(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  test("rejects durations that overflow or exceed the timer limit", () => {
    expect(parseDuration("9".repeat(308) + " days")).toBeUndefined()
    expect(parseOptions({ interval: "900000000 days" }).ok).toBe(false)
    expect(parseOptions({ interval: 2_147_483_648 }).ok).toBe(false)
    expect(parseOptions({ interval: 2_147_483_647 }).ok).toBe(true)
  })

  test("applies defaults and accepts numeric milliseconds", () => {
    expect(parseOptions(undefined)).toEqual({
      ok: true,
      settings: { prompt: DEFAULT_PROMPT, interval: DEFAULT_INTERVAL, duration: DEFAULT_DURATION, models: [] },
    })
    const custom = parseOptions({ prompt: "ping", interval: 1000, duration: "2m" })
    expect(custom.ok && custom.settings).toEqual({
      prompt: "ping",
      interval: 1000,
      duration: 120_000,
      models: [],
    })
  })

  test("parses model rules from a string or an array", () => {
    expect(parseModelRules(undefined)).toEqual([])
    expect(parseModelRules("anthropic/*")).toEqual([{ pattern: "anthropic/*", exclude: false }])
    expect(parseModelRules(["anthropic/*", " !anthropic/claude-sonnet-5 "])).toEqual([
      { pattern: "anthropic/*", exclude: false },
      { pattern: "anthropic/claude-sonnet-5", exclude: true },
    ])
  })

  test("rejects malformed model rules", () => {
    expect(parseModelRules("")).toBeUndefined()
    expect(parseModelRules("!")).toBeUndefined()
    expect(parseModelRules(["anthropic/*", 4])).toBeUndefined()
    expect(parseModelRules({ model: "anthropic/*" })).toBeUndefined()
    const parsed = parseOptions({ models: ["anthropic/*", null] })
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.warning).toContain("models")
  })

  test("stays silent when explicitly disabled", () => {
    expect(parseOptions({ enabled: false, interval: "abc" })).toEqual({ ok: false })
  })

  test("warns when a value is invalid", () => {
    const parsed = parseOptions({ interval: "abc" })
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.warning).toContain("interval")
  })
})
