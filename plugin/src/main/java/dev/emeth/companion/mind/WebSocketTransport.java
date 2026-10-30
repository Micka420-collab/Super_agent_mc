package dev.emeth.companion.mind;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;

/** {@link Transport} over the JDK's own WebSocket client: no dependency, frames reassembled, sends serialised. */
public final class WebSocketTransport implements Transport {

    private final WebSocket socket;
    private CompletableFuture<?> sendChain = CompletableFuture.completedFuture(null);
    private volatile boolean open = true;

    private WebSocketTransport(WebSocket socket) {
        this.socket = socket;
    }

    /** The {@link Connector} used in production. A local mind is reached without any proxy. */
    public static Connector connector(Duration connectTimeout) {
        return (uri, listener) -> {
            HttpClient.Builder http = HttpClient.newBuilder().connectTimeout(connectTimeout);
            if (MindClient.isLocal(uri)) http.proxy(HttpClient.Builder.NO_PROXY);
            Relay relay = new Relay(listener);
            return http.build()
                    .newWebSocketBuilder()
                    .connectTimeout(connectTimeout)
                    .buildAsync(uri, relay)
                    .thenApply(ws -> {
                        WebSocketTransport t = new WebSocketTransport(ws);
                        relay.owner = t;
                        return (Transport) t;
                    });
        };
    }

    @Override
    public synchronized CompletableFuture<Void> send(String text) {
        // java.net.http forbids overlapping sendText calls: chain them
        CompletableFuture<Void> next = sendChain.handle((ok, err) -> null)
                .thenCompose(ignored -> socket.sendText(text, true))
                .thenApply(ws -> (Void) null);
        sendChain = next;
        return next;
    }

    @Override
    public boolean isOpen() {
        return open && !socket.isOutputClosed() && !socket.isInputClosed();
    }

    @Override
    public void close() {
        open = false;
        socket.sendClose(WebSocket.NORMAL_CLOSURE, "bye").exceptionally(err -> null);
        socket.abort();
    }

    /** Reassembles fragmented text messages and forwards them. */
    private static final class Relay implements WebSocket.Listener {
        private final Listener listener;
        private final StringBuilder buffer = new StringBuilder();
        volatile WebSocketTransport owner;

        Relay(Listener listener) {
            this.listener = listener;
        }

        @Override
        public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
            buffer.append(data);
            if (last) {
                String text = buffer.toString();
                buffer.setLength(0);
                listener.onText(text);
            }
            ws.request(1);
            return null;
        }

        @Override
        public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
            closed("closed by the mind (" + statusCode + (reason == null || reason.isBlank() ? "" : ", " + reason) + ")");
            return null;
        }

        @Override
        public void onError(WebSocket ws, Throwable error) {
            closed("connection error: " + error.getMessage());
        }

        private void closed(String reason) {
            WebSocketTransport t = owner;
            if (t != null) t.open = false;
            listener.onClosed(reason);
        }
    }
}
