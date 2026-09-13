export interface Schedule {
  name: string          // 'discovery' | 'metadata' | 'poll' — routed into FetchCtx
  intervalMs: number
  runOnStart: boolean
}

export interface Disposable { close(): void }

/**
 * Three outcomes, because mail's detect() genuinely finds nothing and git's
 * finds a list the user should confirm. A bare null cannot express the middle
 * case, and the middle case is first run's entire job.
 */
export type DetectResult<Cfg> =
  | { kind: 'configured'; config: Partial<Cfg> }
  | { kind: 'candidates'; candidates: Array<{ label: string; config: Partial<Cfg> }> }
  | { kind: 'nothing-to-detect'; reason?: string }

/**
 * Carries the schedule name, without which the git provider physically cannot
 * route discovery vs metadata — the single reason this contract was rewritten.
 */
export interface FetchCtx<Data = unknown> {
  schedule: string
  previous?: Data
  signal: AbortSignal
}

export type Action =
  | { kind: 'exec'; id: string; label: string; keybinding?: string
      argv(target: unknown): { cmd: string; args: string[] } }
  | { kind: 'call'; id: string; label: string; keybinding?: string
      payloadSchema?: { parse(x: unknown): unknown }
      run(target: unknown, cfg: unknown): Promise<void> }

export interface Provider<Cfg, Data> {
  id: string
  configSchema: { parse(x: unknown): Cfg }
  detect(): Promise<DetectResult<Cfg>>
  schedules: Schedule[]
  /** Push source for providers whose data changes off-schedule (obsidian's
   *  filesystem watcher). The interval schedule remains as the fallback for
   *  when the watcher fails or the platform has none. */
  watch?(cfg: Cfg, emit: () => void): Disposable
  fetch(cfg: Cfg, ctx: FetchCtx<Data>): Promise<Data>
  actions: Action[]
}
