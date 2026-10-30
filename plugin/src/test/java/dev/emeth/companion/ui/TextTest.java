package dev.emeth.companion.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import net.kyori.adventure.bossbar.BossBar;
import net.kyori.adventure.text.format.NamedTextColor;
import org.junit.jupiter.api.Test;

class TextTest {

    @Test
    void barsAndPercents() {
        assertEquals("■■■□□", Text.bar(0.6, 5));
        assertEquals("□□□□□", Text.bar(-1, 5));
        assertEquals("■■■■■", Text.bar(7, 5));
        assertEquals("33%", Text.percent(0.33));
        assertEquals("100%", Text.percent(1.4));
    }

    @Test
    void dangerColoursFollowTheOdds() {
        assertEquals(Text.SAGE, Text.dangerColor(0.1));
        assertEquals(NamedTextColor.YELLOW, Text.dangerColor(0.33));
        assertEquals(NamedTextColor.GOLD, Text.dangerColor(0.6));
        assertEquals(NamedTextColor.RED, Text.dangerColor(0.9));
        assertEquals(BossBar.Color.GREEN, Text.dangerBarColor(0));
        assertEquals(BossBar.Color.RED, Text.dangerBarColor(0.8));
    }

    @Test
    void labelsInBothLanguagesAndUnknownValuesPassThrough() {
        Lang fr = Lang.of("fr");
        Lang en = Lang.of("en");
        assertEquals("apprenti", Text.label(fr, "stage", "apprentice"));
        assertEquals("apprentice", Text.label(en, "stage", "apprentice"));
        assertEquals("fuir", Text.label(fr, "rec", "flee"));
        assertEquals("mystery", Text.label(fr, "stage", "mystery"));
        assertEquals("?", Text.label(fr, "stage", null));
        assertEquals("Dans la tête de Emeth", fr.t("menu.title", "Emeth"));
        assertEquals("nope.key", fr.t("nope.key"));
        assertEquals("mood.cheerful", Text.moodKey(0.9));
        assertEquals("mood.miserable", Text.moodKey(0.1));
    }

    @Test
    void iconsForWhatTheBodyDoes() {
        assertEquals("⛏", Text.actionIcon("descend({\"toY\": -58})"));
        assertEquals("⚔", Text.actionIcon("attack"));
        assertEquals("⌂", Text.actionIcon("design & build: a cottage"));
        assertEquals("⚒", Text.actionIcon("get({\"name\": \"torch\"})"));
        assertEquals("☾", Text.actionIcon("sleep"));
        assertEquals("➜", Text.actionIcon("goto"));
        assertEquals("●", Text.actionIcon(null));
    }

    @Test
    void wrapsTruncatesAndCleans() {
        assertEquals(List.of("je vais descendre", "vers le fer"), Text.wrap("je vais descendre vers le fer", 18, 3));
        List<String> cut = Text.wrap("un deux trois quatre cinq six sept huit", 10, 2);
        assertEquals(2, cut.size());
        assertTrue(cut.get(1).endsWith("…"));
        assertTrue(cut.get(1).length() <= 10);
        assertEquals(List.of("abcde", "fghij", "k"), Text.wrap("abcdefghijk", 5, 5));
        assertEquals("abc…", Text.truncate("abcdefgh", 4));
        assertEquals("retine ete", Text.ascii("rétine  été"));
        assertEquals("Y 64 jour 3", Text.ascii("Y 64 ☀ jour 3"));
        assertEquals("salut", Text.sanitize("§csalut\u0007", 100));
        assertEquals("abc", Text.sanitize("abcdef", 3));
    }
}
