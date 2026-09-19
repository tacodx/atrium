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
   * The redaction seam. `/api/state` serves one envelope per provider,
   * `{ data?, schedules }` (`ProviderStatus` in src/core/scheduler.ts), and
   * the `.data` member of that envelope — the same `.data` an onUpdate
   * listener receives — is the return value of this function, never `Data`
   * itself. The scheduler applies it once per successful run and stores the
   * result in one place. `schedules` is the scheduler's own record and is not
   * this function's output; see the last paragraph.
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
   * Closed set in the RETURN VALUE: any status or error value in the object
   * this returns is one of a small set of codes the provider declares, plus
   * their declared operands. §7.4's four-way `ok` / `stale` / `unavailable` /
   * `unsupported-shape` is the model, not a universal enum. Never a caught
   * exception object and never its text: no `e.message`, no `e.stack`, no
   * `String(e)`. Exception text carries absolute paths, argv and occasionally
   * credentials, and the client has no use for any of it.
   *
   * Both rules are CONVENTIONS, held by each provider's own redaction test and
   * by review — not checks. The return type is `unknown`, so identity and
   * `{ ...data }` both typecheck, and nothing at registration or at the call
   * site inspects the shape. The compile-time guarantee is exactly that the
   * member exists.
   *
   * What this seam does NOT cover: the scheduler's failure record. When
   * `fetch` throws (or `watch` throws on installation), `recordFailure` in
   * src/core/scheduler.ts stores the exception's `message` as
   * `schedules.<name>.lastErrorMessage`, and that string is served by
   * `/api/state` and carried in every onUpdate envelope as-is. It is a
   * separate, provider-controlled, currently unredacted text channel that
   * `toClient` never sees, so a provider must never throw with `Data`, a path
   * or a credential in the message. Sanitizing or closing that channel is an
   * open item for the wire task (Task 6) or a plan-level ruling; this seam
   * does not claim it.
   */
  toClient(data: Data): unknown
  actions: Action[]
}
