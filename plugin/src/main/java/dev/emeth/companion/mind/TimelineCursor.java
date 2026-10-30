package dev.emeth.companion.mind;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;

/**
 * Turns repeated reads of "the last N timeline entries" into "what is new since last time". The first read only primes
 * the cursor — joining a server must not replay the agent's whole past into the chat.
 */
public final class TimelineCursor {
    private static final int MEMORY = 600;

    private final LinkedHashSet<String> seen = new LinkedHashSet<>();
    private boolean primed;

    public synchronized List<TimelineEntry> fresh(List<TimelineEntry> recent) {
        List<TimelineEntry> out = new ArrayList<>();
        for (TimelineEntry e : recent) {
            if (seen.add(e.key()) && primed) out.add(e);
        }
        primed = true;
        while (seen.size() > MEMORY) {
            Iterator<String> it = seen.iterator();
            it.next();
            it.remove();
        }
        return out;
    }

    public synchronized boolean isPrimed() {
        return primed;
    }
}
