/**
 * An inert stand-in for DispatchOptions.launcher (src/core/actions.ts), passed
 * by EVERY dispatch in test/ (pinned, by value, in test/launcher-pin.test.ts).
 * Most of those dispatches are expected to reject long before spawnDetached
 * is reached — but they are re-run under mutants, and a mutant deletes
 * exactly the check that makes them reject. Under the DEFAULT launcher
 * ('systemd-run') a mutation run would then open a real editor or terminal on
 * the operator's desktop, silently, once per case. /bin/false STARTS and
 * exits 1, so spawnDetached's fallback — which keys on the `error` event,
 * i.e. on failing to start, never on the exit status — does not fire, and
 * nothing is launched. An absent path would be WORSE than the default:
 * failing to start is exactly what triggers the bare, unscoped relaunch of
 * the command itself.
 */
export const INERT_LAUNCHER = '/bin/false'
