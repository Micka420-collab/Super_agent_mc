package dev.emeth.companion.mind;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

class MindClientTest {

    /** A mind on the other end of a fake wire: answers each request with {@code reply.apply(request)} (null = silence). */
    static final class FakeMind implements Transport.Connector {
        final List<JsonObject> received = new ArrayList<>();
        final AtomicInteger connects = new AtomicInteger();
        URI lastUri;
        Function<JsonObject, String> reply;
        Transport.Listener listener;
        volatile boolean open = true;
        boolean refuse;

        FakeMind(Function<JsonObject, String> reply) {
            this.reply = reply;
        }

        @Override
        public CompletableFuture<Transport> connect(URI uri, Transport.Listener l) {
            connects.incrementAndGet();
            lastUri = uri;
            if (refuse) return CompletableFuture.failedFuture(new java.io.IOException("connection refused"));
            listener = l;
            open = true;
            return CompletableFuture.completedFuture(new Transport() {
                @Override
                public CompletableFuture<Void> send(String text) {
                    JsonObject req = JsonParser.parseString(text).getAsJsonObject();
                    synchronized (received) {
                        received.add(req);
                    }
                    String answer = reply.apply(req);
                    if (answer != null) listener.onText(answer);
                    return CompletableFuture.completedFuture(null);
                }

                @Override
                public boolean isOpen() {
                    return open;
                }

                @Override
                public void close() {
                    open = false;
                }
            });
        }

        void drop(String reason) {
            open = false;
            listener.onClosed(reason);
        }
    }

    static String ok(JsonObject req, String resultJson) {
        return "{\"id\":\"" + req.get("id").getAsString() + "\",\"ok\":true,\"result\":" + resultJson + "}";
    }

    private static MindClient client(FakeMind mind, Duration timeout) {
        return new MindClient(URI.create("ws://127.0.0.1:8766"), "s3cr&t", mind, timeout);
    }

    @Test
    void framesRequestsAndMatchesAnswersById() throws Exception {
        FakeMind mind = new FakeMind(req -> ok(req, "{\"echo\":\"" + req.get("method").getAsString() + "\"}"));
        try (MindClient c = client(mind, Duration.ofSeconds(2))) {
            JsonElement r = c.call("status", Map.of()).get(2, TimeUnit.SECONDS);
            assertEquals("status", r.getAsJsonObject().get("echo").getAsString());
            JsonElement r2 = c.call("tell", Map.of("text", "va vers le fer", "source", "Micka")).get(2, TimeUnit.SECONDS);
            assertEquals("tell", r2.getAsJsonObject().get("echo").getAsString());
            JsonObject sent = mind.received.get(1);
            assertEquals("tell", sent.get("method").getAsString());
            assertEquals("va vers le fer", sent.getAsJsonObject("params").get("text").getAsString());
            assertFalse(sent.get("id").getAsString().equals(mind.received.get(0).get("id").getAsString()));
            assertEquals(1, mind.connects.get(), "one persistent connection");
            assertEquals("ws://127.0.0.1:8766/?token=s3cr%26t", mind.lastUri.toString());
            assertEquals("ws://127.0.0.1:8766/?token=***", c.redacted(), "the token never shows in logs");
        }
    }

    @Test
    void surfacesTheMindsErrorCodes() {
        FakeMind mind = new FakeMind(req -> "{\"id\":\"" + req.get("id").getAsString() + "\",\"ok\":false,\"error\":{\"code\":\"BAD_REQUEST\",\"message\":\"goal title is empty\"}}");
        try (MindClient c = client(mind, Duration.ofSeconds(2))) {
            ExecutionException e = assertThrows(ExecutionException.class, () -> c.call("set_goal", Map.of("title", "")).get(2, TimeUnit.SECONDS));
            MindException m = MindException.of(e);
            assertEquals("BAD_REQUEST", m.code());
            assertEquals("goal title is empty", m.getMessage());
        }
    }

    @Test
    void anUnauthorizedFrameFailsEveryWaitingCall() {
        FakeMind mind = new FakeMind(req -> "{\"id\":null,\"ok\":false,\"error\":{\"code\":\"UNAUTHORIZED\",\"message\":\"bad or missing token\"}}");
        try (MindClient c = client(mind, Duration.ofSeconds(2))) {
            ExecutionException e = assertThrows(ExecutionException.class, () -> c.call("status", Map.of()).get(2, TimeUnit.SECONDS));
            assertEquals(MindException.UNAUTHORIZED, MindException.of(e).code());
        }
    }

    @Test
    void timesOutSilentCallsAndReconnectsAfterADrop() throws Exception {
        FakeMind mind = new FakeMind(req -> null);
        try (MindClient c = client(mind, Duration.ofMillis(150))) {
            ExecutionException e = assertThrows(ExecutionException.class, () -> c.call("status", Map.of()).get(2, TimeUnit.SECONDS));
            assertEquals(MindException.TIMEOUT, MindException.of(e).code());

            CompletableFuture<JsonElement> pending = c.call("status", Map.of());
            mind.drop("closed by the mind (1001)");
            ExecutionException dropped = assertThrows(ExecutionException.class, () -> pending.get(2, TimeUnit.SECONDS));
            assertEquals(MindException.UNREACHABLE, MindException.of(dropped).code());
            assertFalse(c.isConnected());

            mind.reply = req -> ok(req, "{}");
            assertTrue(c.call("status", Map.of()).get(2, TimeUnit.SECONDS).isJsonObject());
            assertEquals(2, mind.connects.get(), "the next call reopened the connection");
        }
    }

    @Test
    void anUnreachableMindIsReportedWithoutTheToken() {
        FakeMind mind = new FakeMind(req -> null);
        mind.refuse = true;
        try (MindClient c = client(mind, Duration.ofSeconds(1))) {
            ExecutionException e = assertThrows(ExecutionException.class, () -> c.call("status", Map.of()).get(2, TimeUnit.SECONDS));
            MindException m = MindException.of(e);
            assertEquals(MindException.UNREACHABLE, m.code());
            assertTrue(m.getMessage().contains("connection refused"));
            assertFalse(m.getMessage().contains("s3cr"));
        }
    }

    @Test
    void knowsWhatIsLocalAndBuildsTokenUrls() {
        assertTrue(MindClient.isLocal(URI.create("ws://127.0.0.1:8766")));
        assertTrue(MindClient.isLocal(URI.create("ws://localhost:8766")));
        assertFalse(MindClient.isLocal(URI.create("ws://10.1.2.3:8766")));
        assertEquals("ws://h:1/x?a=b&token=t", MindClient.withToken(URI.create("ws://h:1/x?a=b"), "t").toString());
        assertEquals("ws://h:1/?token=t", MindClient.withToken(URI.create("ws://h:1/"), "t").toString());
        assertEquals("ws://h:1", MindClient.withToken(URI.create("ws://h:1"), "").toString());
    }

    @Test
    void backsOffExponentiallyAndResets() {
        Backoff b = new Backoff(1_000, 30_000);
        assertTrue(b.ready(0));
        assertEquals(1_000, b.fail(0));
        assertFalse(b.ready(500));
        assertTrue(b.ready(1_000));
        assertEquals(2_000, b.fail(1_000));
        assertEquals(4_000, b.fail(3_000));
        for (int i = 0; i < 10; i++) b.fail(0);
        assertEquals(30_000, b.fail(0));
        b.succeed();
        assertTrue(b.ready(0));
        assertEquals(0, b.failures());
    }
}
