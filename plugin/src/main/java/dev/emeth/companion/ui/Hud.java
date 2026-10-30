package dev.emeth.companion.ui;

import dev.emeth.companion.mind.MindLink;
import dev.emeth.companion.mind.MindSnapshot;
import io.papermc.paper.scoreboard.numbers.NumberFormat;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.kyori.adventure.bossbar.BossBar;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Bukkit;
import org.bukkit.NamespacedKey;
import org.bukkit.entity.Player;
import org.bukkit.persistence.PersistentDataType;
import org.bukkit.plugin.Plugin;
import org.bukkit.scoreboard.Criteria;
import org.bukkit.scoreboard.DisplaySlot;
import org.bukkit.scoreboard.Objective;
import org.bukkit.scoreboard.Score;
import org.bukkit.scoreboard.Scoreboard;

/**
 * The heads-up display for players who follow the agent: a boss bar (current goal, ladder progress, coloured by
 * danger), an action-bar line (vitals, odds, what it does) and a sidebar (mood, strongest drives, task, last thought).
 * The choice is remembered on the player (persistent data), so it survives reconnections and restarts.
 */
public final class Hud {
    private static final int MAX_SIDEBAR_LINES = 13;

    private final Lang lang;
    private final NamespacedKey key;
    private final boolean showSidebar;
    private final boolean showBossbar;
    private final boolean showActionbar;
    private final Map<UUID, Session> sessions = new HashMap<>();

    private record Session(BossBar bar, Scoreboard board, Objective objective, Scoreboard previous) {}

    public Hud(Plugin plugin, Lang lang, boolean sidebar, boolean bossbar, boolean actionbar) {
        this.lang = lang;
        this.key = new NamespacedKey(plugin, "hud");
        this.showSidebar = sidebar;
        this.showBossbar = bossbar;
        this.showActionbar = actionbar;
    }

    public boolean isFollowing(Player p) {
        return sessions.containsKey(p.getUniqueId());
    }

    public List<Player> followers() {
        List<Player> out = new ArrayList<>();
        for (UUID id : sessions.keySet()) {
            Player p = Bukkit.getPlayer(id);
            if (p != null && p.isOnline()) out.add(p);
        }
        return out;
    }

    /** Toggle and remember. Returns the new state. */
    public boolean toggle(Player p) {
        boolean on = !isFollowing(p);
        p.getPersistentDataContainer().set(key, PersistentDataType.BOOLEAN, on);
        if (on) attach(p);
        else detach(p);
        return on;
    }

    /** On join: restore the player's choice (or the server default for newcomers). */
    public void restore(Player p, boolean defaultOn) {
        Boolean saved = p.getPersistentDataContainer().get(key, PersistentDataType.BOOLEAN);
        if (saved != null ? saved : defaultOn) attach(p);
    }

    private void attach(Player p) {
        if (sessions.containsKey(p.getUniqueId())) return;
        BossBar bar = BossBar.bossBar(Component.text("EMETH", Text.GOLD), 0f, BossBar.Color.WHITE, BossBar.Overlay.NOTCHED_10);
        if (showBossbar) p.showBossBar(bar);
        Scoreboard previous = p.getScoreboard();
        Scoreboard board = null;
        Objective objective = null;
        if (showSidebar) {
            board = Bukkit.getScoreboardManager().getNewScoreboard();
            objective = board.registerNewObjective("emeth", Criteria.DUMMY, Component.text("✦ EMETH", Text.GOLD).decorate(TextDecoration.BOLD));
            objective.setDisplaySlot(DisplaySlot.SIDEBAR);
            objective.numberFormat(NumberFormat.blank());
            p.setScoreboard(board);
        }
        sessions.put(p.getUniqueId(), new Session(bar, board, objective, previous));
    }

    public void detach(Player p) {
        Session s = sessions.remove(p.getUniqueId());
        if (s == null) return;
        p.hideBossBar(s.bar());
        if (s.board() != null && p.getScoreboard() == s.board()) p.setScoreboard(s.previous() != null ? s.previous() : Bukkit.getScoreboardManager().getMainScoreboard());
    }

    /** Player left: drop the session but keep their saved choice. */
    public void forget(Player p) {
        Session s = sessions.remove(p.getUniqueId());
        if (s != null) p.hideBossBar(s.bar());
    }

    public void shutdown() {
        for (Player p : followers()) detach(p);
        sessions.clear();
    }

    /** Main thread, after every poll. */
    public void update(MindLink.State state, MindSnapshot s) {
        for (Player p : followers()) {
            Session session = sessions.get(p.getUniqueId());
            if (session == null) continue;
            BossBar bar = session.bar();
            bar.name(bossTitle(lang, state, s));
            bar.progress(state == MindLink.State.ONLINE && s != null ? (float) s.goals().progress() : 0f);
            bar.color(state != MindLink.State.ONLINE || s == null ? BossBar.Color.WHITE : Text.dangerBarColor(s.threat().danger()));
            if (showActionbar) p.sendActionBar(actionBar(lang, state, s));
            if (session.objective() != null) writeSidebar(session, sidebar(lang, state, s));
        }
    }

    private static void writeSidebar(Session session, List<Component> lines) {
        Objective o = session.objective();
        Scoreboard board = session.board();
        if (o == null || board == null) return;
        o.displayName(lines.isEmpty() ? Component.text("✦ EMETH", Text.GOLD) : lines.getFirst());
        int n = Math.min(MAX_SIDEBAR_LINES, lines.size() - 1);
        for (int i = 0; i < MAX_SIDEBAR_LINES; i++) {
            String entry = "emeth-" + i;
            if (i < n) {
                Score score = o.getScore(entry);
                score.setScore(n - i);
                score.customName(lines.get(i + 1));
            } else {
                board.resetScores(entry);
            }
        }
    }

    // --- pure renderers (unit-tested) ---------------------------------------------------------
    public static Component bossTitle(Lang lang, MindLink.State state, MindSnapshot s) {
        if (state == MindLink.State.UNAUTHORIZED) return Component.text("EMETH · " + lang.t("state.unauthorized"), Text.CLAY);
        if (state != MindLink.State.ONLINE || s == null) return Component.text("EMETH · " + lang.t(state == MindLink.State.CONNECTING ? "state.connecting" : "state.offline"), Text.SLATE);
        String goal = s.task() != null ? s.task() : (!s.goals().active().isEmpty() ? s.goals().active().getFirst() : lang.t("hud.no_goal"));
        String ladder = s.goals().done().size() + "/" + s.goals().total();
        return Component.text()
                .append(Component.text(s.name() + " ", Text.GOLD).decorate(TextDecoration.BOLD))
                .append(Component.text("· " + lang.t("hud.goal") + " : " + Text.truncate(goal, 48) + " ", Text.INK))
                .append(Component.text("· " + lang.t("hud.ladder") + " " + ladder, Text.SLATE))
                .build();
    }

    public static Component actionBar(Lang lang, MindLink.State state, MindSnapshot s) {
        if (state != MindLink.State.ONLINE || s == null) return Component.text("☾ EMETH · " + lang.t(state == MindLink.State.UNAUTHORIZED ? "state.unauthorized" : "state.offline"), Text.SLATE);
        var b = Component.text();
        if (!s.bodyConnected()) return b.append(Component.text("☾ " + lang.t("state.body_off"), Text.SLATE)).build();
        MindSnapshot.Vitals v = s.vitals();
        if (v != null) {
            b.append(Component.text("❤ " + Math.round(v.health()) + " ", NamedTextColor.RED));
            b.append(Component.text("✚ " + Math.round(v.food()) + " ", NamedTextColor.GOLD));
            b.append(Component.text((v.phase().equals("night") || v.phase().equals("dusk") ? "☾ " : "☀ ") + Text.label(lang, "phase", v.phase()) + " " + v.day() + "  ", Text.SLATE));
        }
        MindSnapshot.Threat t = s.threat();
        if (t.count() > 0) b.append(Component.text("☠ " + Text.percent(t.danger()) + " " + Text.label(lang, "rec", t.recommendation()) + "  ", Text.dangerColor(t.danger())));
        String doing = s.action() != null ? s.action() : s.thought().intent();
        if (doing != null && !doing.isBlank()) b.append(Component.text(Text.actionIcon(doing) + " " + Text.truncate(doing, 36), Text.INK));
        return b.build();
    }

    /** First element is the sidebar title; at most 13 lines follow. */
    public static List<Component> sidebar(Lang lang, MindLink.State state, MindSnapshot s) {
        List<Component> out = new ArrayList<>();
        if (state != MindLink.State.ONLINE || s == null) {
            out.add(Component.text("✦ EMETH", Text.GOLD).decorate(TextDecoration.BOLD));
            out.add(Component.text(lang.t(state == MindLink.State.UNAUTHORIZED ? "state.unauthorized" : state == MindLink.State.CONNECTING ? "state.connecting" : "state.offline"), Text.SLATE));
            return out;
        }
        out.add(Component.text("✦ " + s.name().toUpperCase(java.util.Locale.ROOT) + " ", Text.GOLD).decorate(TextDecoration.BOLD)
                .append(Component.text("· " + Text.label(lang, "stage", s.stage()), Text.SLATE).decoration(TextDecoration.BOLD, false)));
        out.add(Component.text(lang.t("hud.mood") + " : " + lang.t(Text.moodKey(s.mood())), Text.INK));
        List<Map.Entry<String, Double>> drives = new ArrayList<>();
        for (String k : Text.DRIVES) drives.add(Map.entry(k, s.drive(k)));
        drives.sort((a, b) -> Double.compare(b.getValue(), a.getValue()));
        for (Map.Entry<String, Double> d : drives.subList(0, Math.min(4, drives.size()))) {
            out.add(Component.text(Text.bar(d.getValue(), 5) + " ", d.getValue() >= 0.75 ? Text.CLAY : Text.SAGE)
                    .append(Component.text(Text.label(lang, "drive", d.getKey()), Text.SLATE)));
        }
        MindSnapshot.Threat t = s.threat();
        out.add(Component.text(lang.t("hud.danger") + " : " + Text.percent(t.danger()) + (t.count() > 0 ? " · " + Text.label(lang, "rec", t.recommendation()) : ""), Text.dangerColor(t.danger())));
        if (s.task() != null) {
            out.add(Component.text(lang.t("hud.task") + " :", Text.SLATE));
            for (String line : Text.wrap(s.task(), 26, 2)) out.add(Component.text(" " + line, Text.INK));
        }
        if (!s.thought().reason().isBlank()) {
            out.add(Component.text(lang.t("hud.thought") + " :", Text.SLATE));
            for (String line : Text.wrap(s.thought().reason(), 26, 2)) out.add(Component.text(" " + line, Text.INK).decorate(TextDecoration.ITALIC));
        }
        if (s.reflection() != null && s.reflection().stuck()) out.add(Component.text("⟳ " + lang.t("hud.stuck"), Text.CLAY));
        return out.subList(0, Math.min(out.size(), MAX_SIDEBAR_LINES + 1));
    }
}
