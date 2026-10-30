package dev.emeth.companion.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class BookPagerTest {

    @Test
    void wrapsParagraphsIntoPagesWithoutOverflow() {
        List<String> paragraphs = new ArrayList<>();
        for (int i = 0; i < 30; i++) paragraphs.add("Entrée " + i + " : j'ai miné du fer près de la rivière et je rentre");
        List<String> pages = BookPager.paginate(paragraphs);
        assertTrue(pages.size() > 5);
        for (String page : pages) {
            String[] lines = page.split("\n");
            assertTrue(lines.length <= BookPager.LINES_PER_PAGE, "page too long: " + lines.length);
            for (String line : lines) assertTrue(line.length() <= BookPager.LINE_WIDTH, "line too wide: " + line);
        }
        assertTrue(pages.getFirst().startsWith("Entrée 0"));
    }

    @Test
    void anEmptyJournalIsStillABook() {
        assertEquals(List.of(""), BookPager.paginate(List.of()));
    }

    @Test
    void neverExceedsTheBookLimit() {
        List<String> many = new ArrayList<>();
        for (int i = 0; i < 2000; i++) many.add("ligne " + i);
        assertEquals(BookPager.MAX_PAGES, BookPager.paginate(many).size());
    }
}
