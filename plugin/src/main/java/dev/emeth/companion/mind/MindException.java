package dev.emeth.companion.mind;

/** A failed call to the mind's control channel, with the channel's error code (UNREACHABLE, UNAUTHORIZED, BAD_REQUEST…). */
public final class MindException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public static final String UNREACHABLE = "UNREACHABLE";
    public static final String UNAUTHORIZED = "UNAUTHORIZED";
    public static final String TIMEOUT = "TIMEOUT";

    private final String code;

    public MindException(String code, String message) {
        super(message);
        this.code = code == null ? "ERROR" : code;
    }

    public String code() {
        return code;
    }

    /** Unwrap the CompletableFuture layers to the MindException that caused a failure, if any. */
    public static MindException of(Throwable error) {
        Throwable t = error;
        while (t != null) {
            if (t instanceof MindException m) return m;
            t = t.getCause();
        }
        return new MindException("ERROR", error == null ? "unknown error" : String.valueOf(error.getMessage()));
    }
}
