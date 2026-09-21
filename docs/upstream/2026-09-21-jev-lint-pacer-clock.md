# Handoff: `Pacer` drains its bucket when the clock goes backwards

**Target repository:** `github.com/mizchi/jev-lint` (local: `~/ghq/github.com/mizchi/jevlint`)
**Target file:** `src/jev.ts`, `Pacer#refill`, line 157 as of `aa08380` (v0.5.0)
**Found in:** jev-test-filter, while porting the same client. Fixed there; the divergence is marked in that file's comment.
**Severity:** low frequency, silent, self-correcting within one burst window. Not a data-loss bug.

## The code

```ts
  private refill(now: number): void {
    this.level = Math.min(this.burst, this.level + ((now - this.at) / 1000) * this.rate);
    this.at = now;
  }
```

## The defect

`refill` assumes the clock only moves forward. When `now < this.at`, the second
term is negative, so the call **subtracts** from the token mirror instead of
adding to it.

`this.at` is only ever set from `Date.now()` (via the constructor default and
every `delay` / `available` / `take` call), so a backwards step of the system
clock is enough. Two ordinary causes:

- an NTP correction stepping the clock back
- a laptop resuming from suspend, where the monotonic assumption is weakest

At the shipped `DEFAULT_TOKENS_PER_SECOND` of 200,000, a one-second backwards
jump removes 200,000 tokens from the mirror. `DEFAULT_TOKEN_BURST` is
1,200,000, so a six-second step empties it outright.

## What it looks like when it happens

Nothing in the log. `Pacer.take` sees a bucket that cannot pay, computes a
`delay`, and waits — for a rate limit **the server is not imposing**. The run
gets slower for no reason a reader can see, no 429 is recorded, `rateLimited`
stays zero, and `tokensPerSecond` in the spend report still shows the
configured rate. It clears itself once the clock's forward motion refills the
bucket, so it presents as an unreproducible slow run.

The `usd` and `inputTokens` figures stay correct; only wall time is affected.

## The fix

Clamp the elapsed time at zero. A clock that moves backwards means *no time
passed*, which is the conservative reading and the only one that cannot cost
tokens.

```ts
  private refill(now: number): void {
    // A clock that goes backwards -- an NTP step, a suspended laptop waking --
    // must not DRAIN the mirror. Unclamped, a one-second backwards jump takes
    // a second's worth of refill out of the bucket, and the client then waits
    // for a limit the server is not imposing. Treat it as no elapsed time.
    const elapsed = Math.max(0, now - this.at);
    this.level = Math.min(this.burst, this.level + (elapsed / 1000) * this.rate);
    this.at = now;
  }
```

`this.at = now` stays unconditional on purpose. Refusing to move `at`
backwards would leave it in the future after a permanent step, and the bucket
would then refuse to refill until the clock caught up — a longer stall than
the one being fixed.

## Test

```ts
test("Pacer treats a backwards clock as no elapsed time", () => {
  const p = new Pacer(1000, 1000, 1_000_000);
  assert.equal(p.available(999_000), 1000);
});
```

Against the current code this returns `0` — the bucket is emptied by the
1,000-millisecond backwards step at a rate of 1,000 tokens per second.

## How it surfaced

`Pacer` is the only class in `jev.ts` whose methods take a `now` parameter, so
it is the only one a test can drive with a synthetic clock — except `take`,
which calls `this.delay(tokens)` with no argument and therefore always reads
`Date.now()`. A test that mixes `take()` with frozen-clock `delay(n, 0)` calls
reaches the negative-elapsed state immediately, which is how this was found.

That asymmetry is worth a second look on its own: `take` cannot be tested
against a synthetic clock at all today. Threading `now` through it would make
the pacer fully testable, but it changes a public signature and was out of
scope for the port, so it is only noted here.

## Scope check

Nothing else in `jev.ts` reads the clock defensively either — `backoff`,
`rateLimitWait` and the `timeoutMs` abort all use durations rather than
absolute instants, so they are unaffected. `refill` is the only place an
absolute timestamp is subtracted from another.
