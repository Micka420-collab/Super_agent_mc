package dev.emeth.companion.mind;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.emeth.companion.Fixtures;
import java.util.List;
import org.junit.jupiter.api.Test;

class MindSnapshotTest {

    @Test
    void parsesTheStatusTheMindReallySends() {
        MindSnapshot s = MindSnapshot.parse(Fixtures.load("status.json"));
        assertEquals("Emeth", s.name());
        assertEquals("newborn", s.stage());
        assertEquals(0, s.level());
        assertTrue(s.bodyConnected());
        assertEquals("Emeth", s.username());
        assertTrue(s.languageMindAvailable());
        assertEquals(1, s.decisions());

        assertNotNull(s.vitals());
        assertEquals(17.0, s.vitals().health());
        assertEquals(13.0, s.vitals().food());
        assertEquals("day", s.vitals().phase());
        assertEquals("overworld", s.vitals().dimension());
        assertEquals("oak_planks", s.vitals().held());
        assertEquals(64.0, s.vitals().y());

        assertEquals(21, s.goals().total());
        assertEquals(List.of("planks", "table"), s.goals().done());
        assertEquals("wood", s.goals().next());
        assertEquals(2 / 21.0, s.goals().progress(), 1e-9);
        assertEquals("Punch a tree and collect 6 logs", s.task());

        assertEquals("greet", s.thought().reason());
        assertEquals("Salut Steve !", s.thought().speech());
        assertTrue(s.thought().intent().startsWith("look_at_player"));

        assertEquals("fight", s.threat().recommendation());
        assertEquals(0.33, s.threat().danger(), 1e-9);
        assertEquals("zombie", s.threat().nearestName());
        assertTrue(s.threat().reasons().contains("no armor"));

        assertNotNull(s.reflection());
        assertFalse(s.reflection().stuck());
        assertNull(s.reflection().sameFailure());
        assertEquals(List.of("Steve"), s.nearbyPlayers());
        assertEquals(1, s.nearbyHostiles());
        assertEquals(0.745, s.mood(), 1e-9);
        assertEquals(0.45, s.drive("safety"), 1e-9);
    }

    @Test
    void survivesAnEmptyOrForeignStatus() {
        MindSnapshot s = MindSnapshot.parse(new JsonObject());
        assertEquals("Emeth", s.name());
        assertNull(s.vitals());
        assertEquals(MindSnapshot.Threat.CALM, s.threat());
        assertTrue(s.thought().isEmpty());
        assertEquals(0, s.goals().progress());
        assertFalse(s.languageMindAvailable());
        MindSnapshot weird = MindSnapshot.parse(JsonParser.parseString("{\"self\": 3, \"drives\": [1,2], \"threat\": \"high\", \"goals\": {\"done\": \"x\"}}"));
        assertNull(weird.vitals());
        assertTrue(weird.drives().isEmpty());
        assertEquals(MindSnapshot.Threat.CALM, weird.threat());
    }

    @Test
    void describesFailureStreaksForHumans() {
        JsonObject status = JsonParser.parseString("{\"reflection\": {\"stuck\": true, \"failure_rate\": 0.75, \"invalid_decisions\": 0,"
                + "\"same_failure\": [\"mine({\\\"name\\\": \\\"diamond_ore\\\"})\", \"NOT_FOUND\", 3], \"code_streak\": [\"NOT_FOUND\", 3]}}").getAsJsonObject();
        MindSnapshot.Reflection r = MindSnapshot.parse(status).reflection();
        assertTrue(r.stuck());
        assertEquals("mine({\"name\": \"diamond_ore\"}) ×3 (NOT_FOUND)", r.sameFailure());
        assertEquals("NOT_FOUND ×3", r.codeStreak());
    }

    @Test
    void readsTheTimelineAndOnlyReportsWhatIsNew() {
        List<TimelineEntry> entries = TimelineEntry.parseAll(Fixtures.load("timeline.json"));
        assertFalse(entries.isEmpty());
        assertTrue(entries.stream().anyMatch(e -> e.kind().equals("achievement") && e.text().equals("milestone reached: planks")));
        TimelineCursor cursor = new TimelineCursor();
        assertTrue(cursor.fresh(entries).isEmpty(), "the first read primes, it does not replay the past");
        assertTrue(cursor.isPrimed());
        TimelineEntry death = new TimelineEntry(1_800_000_000.0, "death", "I died at (1, 2, 3)", 1, List.of());
        List<TimelineEntry> next = new java.util.ArrayList<>(entries.subList(1, entries.size()));
        next.add(death);
        assertEquals(List.of(death), cursor.fresh(next));
        assertTrue(cursor.fresh(next).isEmpty());
    }
}
