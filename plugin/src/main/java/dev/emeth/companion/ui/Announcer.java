package dev.emeth.companion.ui;

import dev.emeth.companion.mind.MindLink;
import dev.emeth.companion.mind.MindSnapshot;
import dev.emeth.companion.mind.TimelineEntry;
import java.util.Collection;
import java.util.Set;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.event.ClickEvent;
import net.kyori.adventure.text.event.HoverEvent;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.entity.Player;

/**
 * Tells the people watching what matters: milestones and deaths from the timeline, the mind going on/offline, and — the
 * EMETH take on AgentCraft's "an agent walks over with a question" — when the agent is going in circles, mentors get a
 * clickable line to whisper another approach.
 */
public final class Announcer {
    private final Lang lang;
    private final Set<String> kinds;
    private final boolean stuckAlert;
    private MindLink.State lastState;
    private boolean wasStuck;

    public Announcer(Lang lang, Set<String> kinds, boolean stuckAlert) {
        this.lang = lang;
        this.kinds = kinds;
        this.stuckAlert = stuckAlert;
    }

    /** Main thread. {@code audience}: who hears the news; {@code mentors}: who may answer a stuck agent. */
    public void handle(MindLink.Update u, Collection<? extends Player> audience, Collection<? extends Player> mentors) {
        String name = u.snapshot() == null ? "Emeth" : u.snapshot().name();
        if (lastState != null && lastState != u.state()) {
            if (u.state() == MindLink.State.ONLINE) broadcast(audience, Component.text(lang.t("announce.online", name), Text.SAGE));
            else if (lastState == MindLink.State.ONLINE) broadcast(audience, Component.text(lang.t("announce.offline", name), Text.CLAY));
        }
        lastState = u.state();
        for (TimelineEntry e : u.fresh()) {
            if (kinds.contains(e.kind())) broadcast(audience, line(name, e));
        }
        MindSnapshot s = u.snapshot();
        boolean stuck = u.state() == MindLink.State.ONLINE && s != null && s.reflection() != null && s.reflection().stuck();
        if (stuckAlert && stuck && !wasStuck) {
            String what = s.reflection().sameFailure() != null ? s.reflection().sameFailure() : s.reflection().codeStreak() != null ? s.reflection().codeStreak() : "";
            Component msg = prefix(name)
                    .append(Component.text(lang.t("announce.stuck", name, Text.truncate(what, 60)) + " ", Text.CLAY))
                    .append(Component.text(lang.t("announce.stuck.action"), Text.GOLD).decorate(TextDecoration.BOLD)
                            .clickEvent(ClickEvent.suggestCommand("/emeth tell "))
                            .hoverEvent(HoverEvent.showText(Component.text(lang.t("announce.stuck.hover"), Text.SLATE))));
            broadcast(mentors, msg);
        }
        wasStuck = stuck;
    }

    public static Component line(String name, TimelineEntry e) {
        String icon = switch (e.kind()) {
            case "achievement" -> "✦ ";
            case "death" -> "☠ ";
            case "failure" -> "✖ ";
            case "observed" -> "◉ ";
            default -> "• ";
        };
        return prefix(name).append(Component.text(icon + Text.truncate(e.text(), 160), "death".equals(e.kind()) ? Text.CLAY : Text.INK));
    }

    private static Component prefix(String name) {
        return Component.text("[" + name + "] ", Text.GOLD);
    }

    private static void broadcast(Collection<? extends Player> to, Component msg) {
        for (Player p : to) p.sendMessage(msg);
    }
}
