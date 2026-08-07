/**
 * Watchdog exit-code contract — single source of truth.
 *
 * The watchdog process (scripts/lib/watchdog.mjs) is the sole producer of
 * these codes; claude-runner.mjs is the sole consumer. Both import this module
 * so the numeric contract exists in exactly one place — previously the two
 * processes each carried bare numeric literals that had to stay in sync by
 * hand. This module holds no logic, only the contract.
 *
 *   0 = success (result written to stdout)
 *   1 = Claude failed or config error
 *   2 = timeout
 *   3 = output limit exceeded
 *   4 = cancelled (IPC disconnect or explicit cancel)
 */

export const EXIT_SUCCESS = 0;
export const EXIT_FAILURE = 1;
export const EXIT_TIMEOUT = 2;
export const EXIT_OUTPUT_LIMIT = 3;
export const EXIT_CANCELLED = 4;
