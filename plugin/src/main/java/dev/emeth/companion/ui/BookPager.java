package dev.emeth.companion.ui;

import java.util.ArrayList;
import java.util.List;

/**
 * Lays lines out into Minecraft book pages: a page holds about 14 lines of ~19 characters. Paragraphs are wrapped and
 * never split mid-line; at most 50 pages (the vanilla limit for a written book is 100, a menu book needs far fewer).
 */
public final class BookPager {
    public static final int LINE_WIDTH = 19;
    public static final int LINES_PER_PAGE = 13;
    public static final int MAX_PAGES = 50;

    private BookPager() {}

    public static List<String> paginate(List<String> paragraphs) {
        List<String> pages = new ArrayList<>();
        List<String> page = new ArrayList<>();
        for (String paragraph : paragraphs) {
            List<String> lines = paragraph.isBlank() ? List.of("") : Text.wrap(paragraph, LINE_WIDTH, 64);
            if (!page.isEmpty() && page.size() + lines.size() > LINES_PER_PAGE) {
                pages.add(String.join("\n", page));
                page = new ArrayList<>();
                if (pages.size() >= MAX_PAGES) return pages;
            }
            for (String line : lines) {
                if (page.size() >= LINES_PER_PAGE) {
                    pages.add(String.join("\n", page));
                    page = new ArrayList<>();
                    if (pages.size() >= MAX_PAGES) return pages;
                }
                page.add(line);
            }
        }
        if (!page.isEmpty()) pages.add(String.join("\n", page));
        if (pages.isEmpty()) pages.add("");
        return pages;
    }
}
