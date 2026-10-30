package dev.emeth.companion.mind;

import java.net.URI;
import java.util.concurrent.CompletableFuture;

/** One open text channel to the mind. The WebSocket implementation is {@link WebSocketTransport}; tests use fakes. */
public interface Transport {

    /** Send one complete text frame. Implementations serialise concurrent sends. */
    CompletableFuture<Void> send(String text);

    boolean isOpen();

    void close();

    /** What the transport reports back, from its own threads. */
    interface Listener {
        void onText(String text);

        void onClosed(String reason);
    }

    /** Opens transports; injected into {@link MindClient}. */
    @FunctionalInterface
    interface Connector {
        CompletableFuture<Transport> connect(URI uri, Listener listener);
    }
}
