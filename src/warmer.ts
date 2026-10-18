import type { SessionHooks } from "@opencode/plugin/promise/session"

export type ContextEvent = SessionHooks["context"]
export type GenerateEvent = SessionHooks["generate"]

export interface Snapshot {
  system: ContextEvent["system"]
  messages: ContextEvent["messages"]
  options: ContextEvent["options"]
  tools: ContextEvent["tools"]
  agent: ContextEvent["agent"]
  modelKey: string
  capturedAt: number
}

interface SessionState {
  snapshot: Snapshot | undefined
  lastActivityAt: number
  timer: ReturnType<typeof setTimeout> | undefined
}

export interface WarmerSettings {
  readonly prompt: string
  readonly interval: number
  readonly duration: number
}

interface WarmerOptions extends WarmerSettings {
  warm: (sessionID: string, prompt: string) => Promise<void>
  now?: () => number
  warn?: (message: string) => void
}

export const INVALIDATING_EVENTS = [
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
] as const

const invalidatingTypes: ReadonlySet<string> = new Set(INVALIDATING_EVENTS)

export function invalidatesTranscript(type: string): boolean {
  return invalidatingTypes.has(type)
}

export function modelKey(model: ContextEvent["model"]): string {
  return `${model.providerID}/${model.id}#${model.variant ?? ""}`
}

function lastMessageText(messages: GenerateEvent["messages"]): string | undefined {
  const content = messages.at(-1)?.content
  if (!Array.isArray(content)) return
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("")
}

function isBackgroundShell(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false
  const shell = (data as { shell?: unknown }).shell
  if (typeof shell !== "object" || shell === null) return false
  const metadata = (shell as { metadata?: unknown }).metadata
  return typeof metadata === "object" && metadata !== null && (metadata as { background?: unknown }).background === true
}

export class Warmer {
  private readonly sessions = new Map<string, SessionState>()
  private readonly pending = new Map<string, number>()
  private readonly now: () => number
  private readonly warn: (message: string) => void
  private disposed = false

  constructor(private readonly options: WarmerOptions) {
    this.now = options.now ?? Date.now
    this.warn = options.warn ?? ((message) => console.warn(message))
  }

  capture(event: ContextEvent): void {
    if (this.disposed) return
    const state = this.state(event.sessionID)
    const at = this.now()
    state.snapshot = {
      system: [...event.system],
      messages: [...event.messages],
      options: { ...event.options },
      tools: { ...event.tools },
      agent: event.agent,
      modelKey: modelKey(event.model),
      capturedAt: at,
    }
    state.lastActivityAt = at
    this.arm(event.sessionID, state)
  }

  replay(event: GenerateEvent): void {
    if (!((this.pending.get(event.sessionID) ?? 0) > 0)) return
    if (lastMessageText(event.messages) !== this.options.prompt) return
    const snapshot = this.sessions.get(event.sessionID)?.snapshot
    if (!snapshot) return
    if (snapshot.modelKey !== modelKey(event.model) || snapshot.agent !== event.agent) return
    if (this.now() - snapshot.capturedAt >= this.options.duration) return
    const tail = event.messages.at(-1)
    if (!tail) return
    event.system = [...snapshot.system]
    event.messages = [...snapshot.messages, tail]
    event.options = { ...snapshot.options }
    this.restoreTools(event.tools, snapshot.tools)
  }

  // The host resolves each tool by the identity of the definition object it supplied, so the captured
  // fields must be written onto those objects; replacing the values would drop every tool.
  private restoreTools(current: GenerateEvent["tools"], captured: ContextEvent["tools"]): void {
    const pairs: Array<[GenerateEvent["tools"][string], ContextEvent["tools"][string]]> = []
    for (const [name, definition] of Object.entries(current)) {
      const saved = captured[name]
      if (saved === undefined) return
      pairs.push([definition, saved])
    }
    if (pairs.length !== Object.keys(captured).length) return
    for (const [definition, saved] of pairs) {
      definition.description = saved.description
      definition.input = saved.input
    }
  }

  handleEvent(type: string, sessionID: string | undefined, data?: unknown): void {
    if (sessionID === undefined || !invalidatesTranscript(type)) return
    // Host message mapping drops background shell results, so they cannot change the request prefix.
    if (type.startsWith("session.shell.") && isBackgroundShell(data)) return
    this.drop(sessionID)
  }

  async warm(sessionID: string): Promise<void> {
    this.pending.set(sessionID, (this.pending.get(sessionID) ?? 0) + 1)
    try {
      await this.options.warm(sessionID, this.options.prompt)
    } finally {
      const remaining = (this.pending.get(sessionID) ?? 1) - 1
      if (remaining > 0) this.pending.set(sessionID, remaining)
      else this.pending.delete(sessionID)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const sessionID of [...this.sessions.keys()]) this.drop(sessionID)
    this.pending.clear()
  }

  has(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  private drop(sessionID: string): void {
    const state = this.sessions.get(sessionID)
    if (!state) return
    if (state.timer !== undefined) clearTimeout(state.timer)
    this.sessions.delete(sessionID)
  }

  private state(sessionID: string): SessionState {
    const existing = this.sessions.get(sessionID)
    if (existing) return existing
    const created: SessionState = { snapshot: undefined, lastActivityAt: this.now(), timer: undefined }
    this.sessions.set(sessionID, created)
    return created
  }

  private arm(sessionID: string, state: SessionState): void {
    if (state.timer !== undefined) clearTimeout(state.timer)
    // Wake for whichever comes first: the next warm, or the moment the snapshot expires.
    const untilExpiry = state.lastActivityAt + this.options.duration - this.now()
    const delay = Math.max(0, Math.min(this.options.interval, untilExpiry))
    const timer = setTimeout(() => {
      void this.tick(sessionID, state)
    }, delay)
    timer.unref?.()
    state.timer = timer
  }

  private async tick(sessionID: string, state: SessionState): Promise<void> {
    if (this.disposed || this.sessions.get(sessionID) !== state) return
    state.timer = undefined
    const idle = this.now() - state.lastActivityAt
    if (idle >= this.options.duration) {
      this.drop(sessionID)
      return
    }
    if (idle < this.options.interval) {
      this.arm(sessionID, state)
      return
    }
    try {
      await this.warm(sessionID)
    } catch (error) {
      this.warn(`[prompt-cache-warmer] warm request failed for ${sessionID}: ${String(error)}`)
    }
    if (this.disposed || this.sessions.get(sessionID) !== state) return
    this.arm(sessionID, state)
  }
}
