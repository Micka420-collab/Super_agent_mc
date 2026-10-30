package dev.emeth.companion.mind;

import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonNull;
import com.google.gson.JsonObject;
import com.google.gson.JsonParseException;
import com.google.gson.JsonParser;
import java.net.InetAddress;
import java.net.URI;
import java.net.URLEncoder;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;

/**
 * JSON-RPC client of the mind's control channel ({@code mind/src/emeth/control.py}).
 *
 * <p>Frames: request {@code {"id","method","params"}} → response {@code {"id","ok":true,"result"}} or
 * {@code {"id","ok":false,"error":{"code","message"}}}. One persistent connection, opened lazily and re-opened on the
 * next call after a drop; every call has a deadline; the token travels as {@code ?token=} like every EMETH channel and
 * is never logged.
 */
public final class MindClient implements AutoCloseable {

    private final URI uri;
    private final Transport.Connector connector;
    private final Duration timeout;
    private final Gson gson = new Gson();
    private final AtomicLong ids = new AtomicLong();
    private final Map<String, CompletableFuture<JsonElement>> pending = new ConcurrentHashMap<>();
    private final ScheduledExecutorService timer;

    private Transport transport;
    private CompletableFuture<Transport> connecting;

    public MindClient(URI baseUri, String token, Transport.Connector connector, Duration timeout) {
        this.uri = withToken(baseUri, token);
        this.connector = connector;
        this.timeout = timeout;
        this.timer = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "emeth-mind-timeouts");
            t.setDaemon(true);
            return t;
        });
    }

    /** Call a method; the future fails with a {@link MindException} carrying the channel's error code. */
    public CompletableFuture<JsonElement> call(String method, Map<String, ?> params) {
        return ensureConnected().thenCompose(t -> {
            String id = Long.toString(ids.incrementAndGet());
            CompletableFuture<JsonElement> future = new CompletableFuture<>();
            pending.put(id, future);
            JsonObject frame = new JsonObject();
            frame.addProperty("id", id);
            frame.addProperty("method", method);
            frame.add("params", params == null ? new JsonObject() : gson.toJsonTree(params));
            timer.schedule(() -> {
                CompletableFuture<JsonElement> f = pending.remove(id);
                if (f != null) f.completeExceptionally(new MindException(MindException.TIMEOUT, method + " took longer than " + timeout.toSeconds() + "s"));
            }, timeout.toMillis(), TimeUnit.MILLISECONDS);
            t.send(gson.toJson(frame)).whenComplete((ok, err) -> {
                if (err != null) {
                    CompletableFuture<JsonElement> f = pending.remove(id);
                    if (f != null) f.completeExceptionally(new MindException(MindException.UNREACHABLE, "send failed: " + err.getMessage()));
                }
            });
            return future;
        });
    }

    public boolean isConnected() {
        Transport t = transport;
        return t != null && t.isOpen();
    }

    private synchronized CompletableFuture<Transport> ensureConnected() {
        if (transport != null && transport.isOpen()) return CompletableFuture.completedFuture(transport);
        if (connecting != null && !connecting.isDone()) return connecting;
        CompletableFuture<Transport> attempt;
        try {
            attempt = connector.connect(uri, new Transport.Listener() {
                @Override
                public void onText(String text) {
                    receive(text);
                }

                @Override
                public void onClosed(String reason) {
                    dropped(reason);
                }
            });
        } catch (RuntimeException e) {
            attempt = CompletableFuture.failedFuture(e);
        }
        connecting = attempt.handle((t, err) -> {
            synchronized (MindClient.this) {
                connecting = null;
                if (err != null) throw new MindException(MindException.UNREACHABLE, "cannot reach the mind at " + redacted() + ": " + MindException.of(err).getMessage());
                transport = t;
                return t;
            }
        });
        return connecting;
    }

    void receive(String text) {
        JsonObject msg;
        try {
            msg = JsonParser.parseString(text).getAsJsonObject();
        } catch (JsonParseException | IllegalStateException e) {
            return; // not ours to interpret
        }
        JsonElement idEl = msg.get("id");
        boolean ok = msg.has("ok") && msg.get("ok").isJsonPrimitive() && msg.get("ok").getAsBoolean();
        MindException error = null;
        if (!ok) {
            JsonObject err = msg.has("error") && msg.get("error").isJsonObject() ? msg.getAsJsonObject("error") : new JsonObject();
            error = new MindException(Json.str(err, "code", "ERROR"), Json.str(err, "message", "control call failed"));
        }
        if (idEl == null || idEl.isJsonNull()) {
            // an unsolicited error frame (e.g. UNAUTHORIZED right before the server closes): every waiting call learns it
            if (error != null) failAll(error);
            return;
        }
        CompletableFuture<JsonElement> f = pending.remove(idEl.getAsString());
        if (f == null) return;
        if (ok) f.complete(msg.has("result") ? msg.get("result") : JsonNull.INSTANCE);
        else f.completeExceptionally(error);
    }

    synchronized void dropped(String reason) {
        transport = null;
        failAll(new MindException(MindException.UNREACHABLE, reason));
    }

    private void failAll(MindException error) {
        for (String id : pending.keySet()) {
            CompletableFuture<JsonElement> f = pending.remove(id);
            if (f != null) f.completeExceptionally(error);
        }
    }

    @Override
    public synchronized void close() {
        if (transport != null) transport.close();
        transport = null;
        failAll(new MindException(MindException.UNREACHABLE, "client closed"));
        timer.shutdownNow();
    }

    /** The URL without its token, for logs and messages. */
    public String redacted() {
        String s = uri.toString();
        int q = s.indexOf("token=");
        return q < 0 ? s : s.substring(0, q) + "token=***";
    }

    public static URI withToken(URI base, String token) {
        if (token == null || token.isBlank()) return base;
        String s = base.toString();
        String sep = base.getRawQuery() == null ? (s.endsWith("/") ? "?" : "/?") : "&";
        return URI.create(s + sep + "token=" + URLEncoder.encode(token, StandardCharsets.UTF_8));
    }

    /** Loopback or unspecified host: the control channel is clear text, so leaving the machine needs an explicit opt-in. */
    public static boolean isLocal(URI uri) {
        String host = uri.getHost();
        if (host == null) return false;
        if (host.equalsIgnoreCase("localhost")) return true;
        try {
            InetAddress address = InetAddress.getByName(host);
            return address.isLoopbackAddress() || address.isAnyLocalAddress();
        } catch (UnknownHostException e) {
            return false;
        }
    }
}
