package dev.emeth.companion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.emeth.companion.mind.TimelineEntry;
import java.util.List;
import org.junit.jupiter.api.Test;

class JournalTest {

    @Test
    void newestFirstWithKindAndRepeats() {
        List<TimelineEntry> entries = List.of(
                new TimelineEntry(0, "plan", "new goal: wood", 1, List.of()),
                new TimelineEntry(0, "achievement", "milestone reached: wood", 3, List.of()));
        List<String> p = EmethCompanion.journalParagraphs(entries);
        assertEquals("ACHIEVEMENT ×3", p.get(0));
        assertEquals("milestone reached: wood", p.get(1));
        assertEquals("", p.get(2));
        assertEquals("PLAN", p.get(3));
        assertTrue(EmethCompanion.journalParagraphs(TimelineEntry.parseAll(Fixtures.load("timeline.json"))).size() >= 3);
    }
}
