export const DEFAULT_PROMPT =
  "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK"

export const DEFAULT_INTERVAL = 4 * 60_000

export const DEFAULT_DURATION = 30 * 60_000

export interface WarmerSettings {
  readonly prompt: string
  readonly interval: number
  readonly duration: number
}

export type ParsedOptions =
  | { readonly ok: true; readonly settings: WarmerSettings }
  | { readonly ok: false; readonly warning?: string }

const units: Record<string, number> = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
}

const durationPattern = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/

// Node and Bun clamp a setTimeout delay above this to about 1 ms, which would turn an oversized
// interval into a continuous stream of paid warm requests.
const MAX_TIMER_MS = 2_147_483_647

/** Accepts milliseconds as a number, or a unit string such as "90s", "4m" or "1 hour". */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value !== "string") return undefined
  const match = durationPattern.exec(value.trim().toLowerCase())
  if (!match) return undefined
  const amount = Number(match[1])
  if (!Number.isFinite(amount)) return undefined
  const unit = match[2] ?? ""
  const scale = unit === "" ? 1 : units[unit]
  if (scale === undefined) return undefined
  const scaled = amount * scale
  return Number.isFinite(scaled) ? scaled : undefined
}

function describe(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value)
}

export function parseOptions(options: Readonly<Record<string, unknown>> | undefined): ParsedOptions {
  const raw = options ?? {}
  if (raw.enabled === false) return { ok: false }
  const interval = parseDuration(raw.interval ?? DEFAULT_INTERVAL)
  if (interval === undefined || interval <= 0 || interval > MAX_TIMER_MS) {
    return {
      ok: false,
      warning: `prompt cache warming is disabled: interval must be a finite positive duration no longer than ${MAX_TIMER_MS} ms, got ${describe(raw.interval)}`,
    }
  }
  const duration = parseDuration(raw.duration ?? DEFAULT_DURATION)
  if (duration === undefined || duration <= 0) {
    return {
      ok: false,
      warning: `prompt cache warming is disabled: duration must be a finite positive duration, got ${describe(raw.duration)}`,
    }
  }
  const prompt = typeof raw.prompt === "string" && raw.prompt.trim().length > 0 ? raw.prompt : DEFAULT_PROMPT
  return { ok: true, settings: { prompt, interval, duration } }
}
