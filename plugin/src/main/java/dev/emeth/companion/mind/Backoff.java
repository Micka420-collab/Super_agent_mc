package dev.emeth.companion.mind;

/** Reconnection pacing: 1 s, 2 s, 4 s … up to a ceiling, reset by the first success. Pure, clock injected. */
public final class Backoff {
    private final long baseMs;
    private final long maxMs;
    private int failures;
    private long notBefore;

    public Backoff(long baseMs, long maxMs) {
        this.baseMs = baseMs;
        this.maxMs = maxMs;
    }

    public synchronized boolean ready(long nowMs) {
        return nowMs >= notBefore;
    }

    public synchronized long fail(long nowMs) {
        failures = Math.min(failures + 1, 30);
        long delay = Math.min(maxMs, baseMs << Math.min(failures - 1, 20));
        notBefore = nowMs + delay;
        return delay;
    }

    public synchronized void succeed() {
        failures = 0;
        notBefore = 0;
    }

    public synchronized int failures() {
        return failures;
    }
}
