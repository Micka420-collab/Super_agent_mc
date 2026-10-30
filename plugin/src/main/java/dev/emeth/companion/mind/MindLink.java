package dev.emeth.companion.mind;

import com.google.gson.JsonElement;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.function.LongSupplier;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * The plugin's link to the running mind: polls {@code status} + {@code timeline} off the server thread, keeps the latest
 * reading, and hands every update to the interface on the thread given as {@code sync} (the server's main thread).
 *
 * <p>It never commands the body. Influence goes through the mind's own mentor methods ({@code tell}, {@code set_goal},
 * {@code say}), which the agent weighs like any other input (ADR-0006, ADR-0007).
 */
public final class MindLink implements AutoCloseable {

    public enum State { CONNECTING, ONLINE, OFFLINE, UNAUTHORIZED }

    /** What the interface receives after every poll. {@code snapshot} is the last good one (may be stale when offline). */
    public record Update(State state, MindSnapshot snapshot, List<TimelineEntry> fresh, String error) {}

    private final MindClient client;
    private final Executor sync;
    private final Logger log;
    private final LongSupplier clock;
    private final Backoff backoff = new Backoff(1_000, 30_000);
    private final TimelineCursor cursor = new TimelineCursor();
    private final AtomicBoolean inFlight = new AtomicBoolean();
    private final List<Consumer<Update>> listeners = new CopyOnWriteArrayList<>();

    private volatile State state = State.CONNECTING;
    private volatile MindSnapshot latest;
    private volatile String lastError = "";

    public MindLink(MindClient client, Executor sync, Logger log, LongSupplier clock) {
        this.client = client;
        this.sync = sync;
        this.log = log;
        this.clock = clock;
    }

    public void onUpdate(Consumer<Update> listener) {
        listeners.add(listener);
    }

    public State state() {
        return state;
    }

    public MindSnapshot latest() {
        return latest;
    }

    public String lastError() {
        return lastError;
    }

    public String endpoint() {
        return client.redacted();
    }

    /** One polling round. Safe to call from any thread; overlapping rounds are skipped; offline rounds back off. */
    public CompletableFuture<Void> poll() {
        if (!backoff.ready(clock.getAsLong()) || !inFlight.compareAndSet(false, true)) return CompletableFuture.completedFuture(null);
        CompletableFuture<JsonElement> status = client.call("status", Map.of());
        CompletableFuture<JsonElement> timeline = client.call("timeline", Map.of("limit", 25));
        return status.thenCombine(timeline, (s, t) -> {
            MindSnapshot snapshot = MindSnapshot.parse(s);
            List<TimelineEntry> fresh = cursor.fresh(TimelineEntry.parseAll(t));
            boolean wasOnline = state == State.ONLINE;
            latest = snapshot;
            state = State.ONLINE;
            lastError = "";
            backoff.succeed();
            if (!wasOnline) log.info("connected to the mind of " + snapshot.name() + " at " + client.redacted());
            return new Update(State.ONLINE, snapshot, fresh, "");
        }).exceptionally(err -> {
            MindException e = MindException.of(err);
            State next = MindException.UNAUTHORIZED.equals(e.code()) ? State.UNAUTHORIZED : State.OFFLINE;
            long delay = backoff.fail(clock.getAsLong());
            if (state != next || !e.getMessage().equals(lastError)) {
                log.log(next == State.UNAUTHORIZED ? Level.SEVERE : Level.WARNING,
                        "mind unavailable (" + e.code() + "): " + e.getMessage() + " — retrying in " + delay / 1000 + "s");
            }
            state = next;
            lastError = e.getMessage();
            return new Update(next, latest, List.of(), e.getMessage());
        }).thenAccept(update -> {
            inFlight.set(false);
            sync.execute(() -> {
                for (Consumer<Update> l : listeners) {
                    try {
                        l.accept(update);
                    } catch (RuntimeException ex) {
                        log.log(Level.WARNING, "interface update failed", ex);
                    }
                }
            });
        });
    }

    // --- influence: advice, never commands ------------------------------------------------------
    public CompletableFuture<JsonElement> tell(String text, String source) {
        return client.call("tell", Map.of("text", text, "source", source));
    }

    public CompletableFuture<JsonElement> suggestGoal(String title, String why, String source) {
        return client.call("set_goal", Map.of("title", title, "why", why, "priority", 4, "source", source));
    }

    public CompletableFuture<JsonElement> say(String text) {
        return client.call("say", Map.of("text", text));
    }

    // --- reading ------------------------------------------------------------------------------
    public CompletableFuture<JsonElement> render(int width, int height) {
        return client.call("render", Map.of("width", width, "height", height));
    }

    public CompletableFuture<JsonElement> goals() {
        return client.call("goals", Map.of());
    }

    public CompletableFuture<JsonElement> timeline(int limit) {
        return client.call("timeline", Map.of("limit", limit));
    }

    @Override
    public void close() {
        client.close();
    }
}
