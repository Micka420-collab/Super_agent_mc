package dev.emeth.companion.ui;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.kyori.adventure.bossbar.BossBar;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextColor;
import net.kyori.adventure.text.format.TextDecoration;

/** Pure formatting: bars, colours, labels, wrapping. Everything the interface writes goes through here (unit-tested). */
public final class Text {
    private Text() {}

    /** The EMETH palette: warm gold for the agent, clay for alerts, sage for calm, slate for secondary text. */
    public static final TextColor GOLD = TextColor.color(0xE0B04B);
    public static final TextColor CLAY = TextColor.color(0xD97757);
    public static final TextColor SAGE = TextColor.color(0x8FA98B);
    public static final TextColor SLATE = TextColor.color(0x9AA4B2);
    public static final TextColor INK = TextColor.color(0xE8E3D8);

    public static final String[] DRIVES = {"safety", "hunger", "rest", "curiosity", "social", "mastery", "order"};

    /** "■■■□□" for 0.6 over 5 cells. */
    public static String bar(double value, int cells) {
        int filled = (int) Math.round(Math.max(0, Math.min(1, value)) * cells);
        return "■".repeat(filled) + "□".repeat(Math.max(0, cells - filled));
    }

    public static String percent(double value) {
        return Math.round(Math.max(0, Math.min(1, value)) * 100) + "%";
    }

    public static TextColor dangerColor(double danger) {
        if (danger < 0.2) return SAGE;
        if (danger < 0.45) return NamedTextColor.YELLOW;
        if (danger < 0.7) return NamedTextColor.GOLD;
        return NamedTextColor.RED;
    }

    public static BossBar.Color dangerBarColor(double danger) {
        if (danger < 0.2) return BossBar.Color.GREEN;
        if (danger < 0.45) return BossBar.Color.YELLOW;
        return BossBar.Color.RED;
    }

    public static String moodKey(double mood) {
        if (mood > 0.7) return "mood.cheerful";
        if (mood > 0.5) return "mood.content";
        if (mood > 0.3) return "mood.uneasy";
        return "mood.miserable";
    }

    public static String label(Lang lang, String prefix, String value) {
        if (value == null) return "?";
        String key = prefix + "." + value;
        return lang.has(key) ? lang.t(key) : value;
    }

    /** A glyph for what the body is doing, from the primitive name or the decision text. */
    public static String actionIcon(String what) {
        if (what == null || what.isBlank()) return "●";
        String s = what.toLowerCase(Locale.ROOT);
        if (s.contains("descend") || s.contains("tunnel") || s.contains("mine") || s.contains("dig")) return "⛏";
        if (s.contains("attack") || s.contains("defend") || s.contains("flee")) return "⚔";
        if (s.contains("design") || s.contains("build") || s.contains("place")) return "⌂";
        if (s.contains("get") || s.contains("craft") || s.contains("smelt")) return "⚒";
        if (s.contains("sleep")) return "☾";
        if (s.contains("wait")) return "⌛";
        if (s.contains("goto") || s.contains("explore") || s.contains("follow") || s.contains("move")) return "➜";
        if (s.contains("skill") || s.contains("program")) return "✎";
        if (s.contains("eat")) return "✚";
        return "●";
    }

    public static String truncate(String s, int max) {
        if (s == null) return "";
        String one = s.replace('\n', ' ').strip();
        if (one.length() <= max) return one;
        return one.substring(0, Math.max(0, max - 1)).stripTrailing() + "…";
    }

    /** Greedy word wrap; long words are cut. At most {@code maxLines} lines, the last one ellipsised if needed. */
    public static List<String> wrap(String s, int width, int maxLines) {
        List<String> lines = new ArrayList<>();
        if (s == null || s.isBlank()) return lines;
        StringBuilder line = new StringBuilder();
        for (String word : s.replace('\n', ' ').strip().split("\\s+")) {
            while (word.length() > width) {
                if (!line.isEmpty()) {
                    lines.add(line.toString());
                    line.setLength(0);
                }
                lines.add(word.substring(0, width));
                word = word.substring(width);
            }
            if (line.length() + word.length() + (line.isEmpty() ? 0 : 1) > width) {
                lines.add(line.toString());
                line.setLength(0);
            }
            if (!line.isEmpty()) line.append(' ');
            line.append(word);
        }
        if (!line.isEmpty()) lines.add(line.toString());
        if (lines.size() > maxLines) {
            List<String> cut = new ArrayList<>(lines.subList(0, maxLines));
            String last = cut.get(maxLines - 1);
            if (last.length() >= width) last = last.substring(0, width - 1);
            cut.set(maxLines - 1, last.stripTrailing() + "…");
            return cut;
        }
        return lines;
    }

    /** Map canvases only draw ASCII: fold accents ("rétine" → "retine"), drop the rest. */
    public static String ascii(String s) {
        if (s == null) return "";
        String folded = Normalizer.normalize(s, Normalizer.Form.NFD).replaceAll("\\p{M}+", "");
        StringBuilder out = new StringBuilder(folded.length());
        for (char c : folded.toCharArray()) out.append(c >= 32 && c < 127 ? c : ' ');
        return out.toString().replaceAll(" {2,}", " ").strip();
    }

    /** Strip legacy colour codes and control characters from player input before it reaches the mind. */
    public static String sanitize(String s, int max) {
        if (s == null) return "";
        String clean = s.replaceAll("§.", "").replaceAll("\\p{Cntrl}", " ").strip();
        return clean.length() > max ? clean.substring(0, max) : clean;
    }

    /** Lore and menu lines must not be italic (the client's default for custom names). */
    public static Component plain(String s, TextColor color) {
        return Component.text(s, color).decoration(TextDecoration.ITALIC, false);
    }

    public static Component title(String s) {
        return Component.text(s, GOLD).decoration(TextDecoration.ITALIC, false).decoration(TextDecoration.BOLD, true);
    }

    public static List<Component> lore(List<String> lines, TextColor color) {
        List<Component> out = new ArrayList<>();
        for (String l : lines) out.add(plain(l, color));
        return out;
    }

    public static String coords(double x, double y, double z) {
        return String.format(Locale.ROOT, "%.0f %.0f %.0f", x, y, z);
    }
}
