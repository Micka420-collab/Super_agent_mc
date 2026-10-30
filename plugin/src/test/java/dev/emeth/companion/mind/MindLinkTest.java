package dev.emeth.companion.mind;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.emeth.companion.Fixtures;
import java.net.URI;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;
import org.junit.jupiter.api.Test;

class MindLinkTest {

    @Test
    void pollsStatusAndTimelineThenGoesOfflineAndBacksOff() throws Exception {
        String status = Fixtures.load("status.json").toString();
        String timeline = Fixtures.load("timeline.json").toString();
        MindClientTest.FakeMind mind = new MindClientTest.FakeMind(req -> MindClientTest.ok(req, req.get("method").getAsString().equals("status") ? status : timeline));
        AtomicLong now = new AtomicLong(10_000);
        List<MindLink.Update> updates = new ArrayList<>();
        try (MindLink link = new MindLink(new MindClient(URI.create("ws://127.0.0.1:1"), "t", mind, Duration.ofSeconds(1)), Runnable::run, Logger.getLogger("test"), now::get)) {
            link.onUpdate(updates::add);
            link.poll().get(2, TimeUnit.SECONDS);
            assertEquals(MindLink.State.ONLINE, link.state());
            assertNotNull(link.latest());
            assertEquals("Emeth", updates.getFirst().snapshot().name());
            assertTrue(updates.getFirst().fresh().isEmpty(), "first poll primes the timeline cursor");

            mind.drop("mind stopped");
            mind.refuse = true;
            link.poll().get(2, TimeUnit.SECONDS);
            assertEquals(MindLink.State.OFFLINE, link.state());
            assertEquals("Emeth", updates.get(1).snapshot().name(), "the last good reading is kept for display");
            int before = updates.size();
            link.poll().get(2, TimeUnit.SECONDS);
            assertEquals(before, updates.size(), "backing off: no new attempt within the delay");
            now.addAndGet(1_500);
            mind.refuse = false;
            link.poll().get(2, TimeUnit.SECONDS);
            assertEquals(MindLink.State.ONLINE, link.state());
        }
    }
}
