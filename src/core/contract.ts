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
  /**
   * The redaction seam, and the only thing that decides what leaves this
   * process. Everything `/api/state` serves and every WS frame the scheduler
   * pushes is the return value of this function — never `Data` itself.
   *
   * REQUIRED, not optional, for the same reason `DispatchOptions.cfg` is
   * required (src/core/actions.ts, where it records that it was hardcoded
   * `undefined` once): an optional member that defaults to identity means the
   * provider author who forgets it ships secrets silently and nothing goes
   * red. A missing `toClient` must be a compile error.
   *
   * Write it as an explicit field-by-field ALLOWLIST — build a fresh object
   * naming each field you intend to expose. NEVER `{ ...data }` with
   * deletions: a deny-list is correct exactly until the next field is added to
   * `Data`, and then it silently is not, with no diff to review.
   *
   * Closed set on the wire: any status or error value in the returned object
   * is one of the declared codes — `ok`, `stale`, `unavailable`,
   * `unsupported-shape` (spec §7.4) — plus their declared operands. Never a
   * caught exception object and never its text: no `e.message`, no `e.stack`,
   * no `String(e)`. Exception text carries absolute paths, argv and
   * occasionally credentials, and the client has no use for any of it.
   */
  toClient(data: Data): unknown
  actions: Action[]
}
