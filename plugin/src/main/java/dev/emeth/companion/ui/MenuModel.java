package dev.emeth.companion.ui;

import dev.emeth.companion.mind.MindLink;
import dev.emeth.companion.mind.MindSnapshot;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.kyori.adventure.text.format.TextColor;
import org.bukkit.Material;

/**
 * What the "inside its head" menu shows, slot by slot — computed without touching the server so it can be unit-tested.
 * {@link MindMenu} turns it into item stacks.
 */
public final class MenuModel {
    public static final int SIZE = 54;

    public enum Action { NONE, GOALS, JOURNAL, MONITOR, TELL, GOAL, HUD, CLOSE }

    public record Slot(Material material, String name, TextColor color, List<String> lore, boolean glint, Action action, int amount) {}

    private static final Map<String, Material> DRIVE_ICONS = Map.of(
            "safety", Material.SHIELD, "hunger", Material.BREAD, "rest", Material.RED_BED, "curiosity", Material.COMPASS,
            "social", Material.CAKE, "mastery", Material.GOLDEN_PICKAXE, "order", Material.CHEST);

    private static final Map<String, Material> ODDS_ICONS = Map.of(
            "calm", Material.OAK_SAPLING, "watch", Material.LANTERN, "fight", Material.IRON_SWORD, "retreat", Material.LEATHER_BOOTS, "flee", Material.RABBIT_FOOT);

    public static final int HEAD = 4;
    public static final int[] DRIVES = {10, 11, 12, 13, 14, 15, 16};
    public static final int THINKING = 19;
    public static final int DOING = 21;
    public static final int ODDS = 23;
    public static final int REFLECTION = 25;
    public static final int GOALS = 28;
    public static final int JOURNAL = 30;
    public static final int MONITOR = 32;
    public static final int LADDER = 34;
    public static final int TELL = 38;
    public static final int GOAL = 40;
    public static final int HUD = 42;
    public static final int CLOSE = 49;

    private MenuModel() {}

    public static Map<Integer, Slot> build(Lang lang, MindLink.State state, MindSnapshot s, boolean canMentor, boolean canMonitor, boolean hudOn) {
        Map<Integer, Slot> slots = new LinkedHashMap<>();
        for (int i = 0; i < SIZE; i++) {
            int row = i / 9;
            int col = i % 9;
            if (row == 0 || row == 5 || col == 0 || col == 8) slots.put(i, new Slot(Material.GRAY_STAINED_GLASS_PANE, " ", Text.SLATE, List.of(), false, Action.NONE, 1));
        }
        slots.put(CLOSE, new Slot(Material.BARRIER, lang.t("menu.close"), Text.CLAY, List.of(), false, Action.CLOSE, 1));

        if (state != MindLink.State.ONLINE || s == null) {
            String why = lang.t(state == MindLink.State.UNAUTHORIZED ? "state.unauthorized" : state == MindLink.State.CONNECTING ? "state.connecting" : "state.offline");
            slots.put(HEAD, new Slot(Material.PLAYER_HEAD, "EMETH", Text.GOLD, List.of(why), false, Action.NONE, 1));
            slots.put(HUD, hudSlot(lang, hudOn));
            return slots;
        }

        List<String> head = new ArrayList<>();
        head.add(lang.t("menu.level", s.level(), Math.round(s.experience())));
        MindSnapshot.Vitals v = s.vitals();
        if (v != null) {
            head.add(lang.t("menu.vitals", Math.round(v.health()), Math.round(v.food()), v.xpLevel()));
            head.add(lang.t("menu.where", v.dimension(), v.day(), Text.label(lang, "phase", v.phase()), Math.round(v.x()), Math.round(v.y()), Math.round(v.z())));
        }
        head.add(s.bodyConnected() ? lang.t("menu.mind_on", s.decisions()) : lang.t("state.body_off"));
        if (!s.languageMindAvailable()) head.add(lang.t("state.instinct"));
        if (!s.nearbyPlayers().isEmpty()) head.add(lang.t("menu.players", String.join(", ", s.nearbyPlayers())));
        head.add(lang.t("hud.mood") + " : " + lang.t(Text.moodKey(s.mood())));
        slots.put(HEAD, new Slot(Material.PLAYER_HEAD, lang.t("menu.status", s.name(), Text.label(lang, "stage", s.stage())), Text.GOLD, head, false, Action.NONE, 1));

        for (int i = 0; i < Text.DRIVES.length; i++) {
            String key = Text.DRIVES[i];
            double value = s.drive(key);
            slots.put(DRIVES[i], new Slot(DRIVE_ICONS.get(key), Text.label(lang, "drive", key) + "  " + Text.bar(value, 10), value >= 0.75 ? Text.CLAY : Text.SAGE,
                    List.of(Text.percent(value)), value >= 0.75, Action.NONE, Math.max(1, (int) Math.round(value * 10))));
        }

        List<String> thinking = new ArrayList<>();
        if (s.thought().isEmpty()) {
            thinking.add(lang.t("menu.nothing"));
        } else {
            if (!s.thought().reason().isBlank()) thinking.addAll(Text.wrap("« " + s.thought().reason() + " »", 40, 4));
            if (!s.thought().intent().isBlank()) thinking.addAll(Text.wrap(lang.t("menu.intent", s.thought().intent()), 40, 2));
            if (!s.thought().speech().isBlank()) thinking.addAll(Text.wrap(lang.t("menu.speech", s.thought().speech()), 40, 3));
        }
        slots.put(THINKING, new Slot(Material.BOOK, lang.t("menu.thinking"), Text.INK, thinking, false, Action.NONE, 1));

        List<String> doing = new ArrayList<>();
        if (s.action() != null) doing.addAll(Text.wrap(lang.t("menu.action", s.action()), 40, 2));
        if (s.task() != null) doing.addAll(Text.wrap(lang.t("menu.task", s.task()), 40, 2));
        if (!s.lastResult().isBlank()) doing.addAll(Text.wrap(lang.t("menu.result", s.lastResult()), 40, 3));
        if (doing.isEmpty()) doing.add(lang.t("holo.idle"));
        String what = s.action() != null ? s.action() : s.thought().intent();
        slots.put(DOING, new Slot(iconFor(what), lang.t("menu.doing"), Text.INK, doing, s.action() != null, Action.NONE, 1));

        MindSnapshot.Threat t = s.threat();
        List<String> odds = new ArrayList<>();
        odds.add(Text.percent(t.danger()) + " → " + Text.label(lang, "rec", t.recommendation()));
        for (String r : t.reasons()) odds.add("· " + r);
        slots.put(ODDS, new Slot(ODDS_ICONS.getOrDefault(t.recommendation(), Material.OAK_SAPLING), lang.t("menu.odds"), Text.dangerColor(t.danger()), odds, t.danger() >= 0.7, Action.NONE, Math.max(1, t.count())));

        List<String> reflection = new ArrayList<>();
        MindSnapshot.Reflection r = s.reflection();
        if (r == null || !r.stuck()) reflection.add(lang.t("menu.reflection.ok"));
        else reflection.add(lang.t("menu.reflection.stuck"));
        if (r != null) {
            reflection.add(lang.t("menu.failure_rate", Text.percent(r.failureRate())));
            if (r.sameFailure() != null) reflection.addAll(Text.wrap(r.sameFailure(), 40, 2));
            else if (r.codeStreak() != null) reflection.add(r.codeStreak());
        }
        slots.put(REFLECTION, new Slot(Material.ENDER_EYE, lang.t("menu.reflection"), r != null && r.stuck() ? Text.CLAY : Text.SAGE, reflection, r != null && r.stuck(), Action.NONE, 1));

        List<String> goals = new ArrayList<>();
        for (String g : s.goals().active()) goals.addAll(Text.wrap("• " + g, 40, 2));
        if (goals.isEmpty()) goals.add(lang.t("hud.no_goal"));
        goals.add(lang.t("menu.click"));
        slots.put(GOALS, new Slot(Material.TARGET, lang.t("menu.goals"), Text.INK, goals, false, Action.GOALS, 1));
        slots.put(JOURNAL, new Slot(Material.KNOWLEDGE_BOOK, lang.t("menu.journal"), Text.INK, List.of(lang.t("menu.click")), false, Action.JOURNAL, 1));
        if (canMonitor) slots.put(MONITOR, new Slot(Material.FILLED_MAP, lang.t("menu.monitor"), Text.INK, Text.wrap(lang.t("menu.monitor.lore"), 40, 3), false, Action.MONITOR, 1));
        String next = s.goals().next() == null ? "—" : s.goals().next();
        slots.put(LADDER, new Slot(Material.LADDER, lang.t("menu.ladder"), Text.INK, List.of(lang.t("menu.ladder.lore", s.goals().done().size(), s.goals().total(), next)), false, Action.NONE,
                Math.max(1, s.goals().done().size())));

        List<String> tellLore = new ArrayList<>(Text.wrap(lang.t("menu.tell.lore"), 40, 3));
        tellLore.add(canMentor ? lang.t("menu.click") : lang.t("menu.mentor_only"));
        slots.put(TELL, new Slot(Material.FEATHER, lang.t("menu.tell"), canMentor ? Text.GOLD : Text.SLATE, tellLore, false, canMentor ? Action.TELL : Action.NONE, 1));
        List<String> goalLore = new ArrayList<>(Text.wrap(lang.t("menu.goal.lore"), 40, 3));
        goalLore.add(canMentor ? lang.t("menu.click") : lang.t("menu.mentor_only"));
        slots.put(GOAL, new Slot(Material.NAME_TAG, lang.t("menu.goal"), canMentor ? Text.GOLD : Text.SLATE, goalLore, false, canMentor ? Action.GOAL : Action.NONE, 1));
        slots.put(HUD, hudSlot(lang, hudOn));
        return slots;
    }

    private static Slot hudSlot(Lang lang, boolean hudOn) {
        List<String> lore = new ArrayList<>(Text.wrap(lang.t("menu.hud.lore"), 40, 2));
        lore.add((hudOn ? "● " : "○ ") + lang.t(hudOn ? "menu.hud.state.on" : "menu.hud.state.off"));
        return new Slot(Material.SPYGLASS, lang.t("menu.hud"), hudOn ? Text.SAGE : Text.SLATE, lore, hudOn, Action.HUD, 1);
    }

    static Material iconFor(String what) {
        return switch (Text.actionIcon(what)) {
            case "⛏" -> Material.IRON_PICKAXE;
            case "⚔" -> Material.IRON_SWORD;
            case "⌂" -> Material.BRICKS;
            case "⚒" -> Material.CRAFTING_TABLE;
            case "☾" -> Material.WHITE_BED;
            case "⌛" -> Material.CLOCK;
            case "➜" -> Material.LEATHER_BOOTS;
            case "✎" -> Material.WRITABLE_BOOK;
            case "✚" -> Material.APPLE;
            default -> Material.STICK;
        };
    }
}
