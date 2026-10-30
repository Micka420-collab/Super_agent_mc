package dev.emeth.companion.ui;

import dev.emeth.companion.mind.MindLink;
import dev.emeth.companion.mind.MindSnapshot;
import java.util.List;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.TextComponent;
import net.kyori.adventure.text.format.NamedTextColor;
import net.kyori.adventure.text.format.TextDecoration;
import org.bukkit.Color;
import org.bukkit.entity.Display;
import org.bukkit.entity.Player;
import org.bukkit.entity.TextDisplay;
import org.bukkit.plugin.Plugin;
import org.bukkit.util.Transformation;
import org.joml.AxisAngle4f;
import org.joml.Vector3f;

/**
 * A floating card above the agent's head: name and stage, what it is doing, what it just thought, the odds. It rides the
 * bot as a passenger and is hidden from the bot itself ({@code hideEntity}) — the interface is for the humans watching,
 * the agent's honest perception never sees it.
 */
public final class Hologram {
    private final Plugin plugin;
    private final Lang lang;
    private final float height;
    private final long thoughtMillis;

    private TextDisplay display;
    private String lastReason = "";
    private long thoughtShownAt;

    public Hologram(Plugin plugin, Lang lang, float height, int thoughtSeconds) {
        this.plugin = plugin;
        this.lang = lang;
        this.height = height;
        this.thoughtMillis = thoughtSeconds * 1000L;
    }

    /** Main thread. {@code bot} null → nothing to float over. */
    public void update(Player bot, MindLink.State state, MindSnapshot snapshot, long nowMs) {
        if (bot == null || !bot.isOnline() || bot.isDead()) {
            remove();
            return;
        }
        if (snapshot != null && !snapshot.thought().reason().isBlank() && !snapshot.thought().reason().equals(lastReason)) {
            lastReason = snapshot.thought().reason();
            thoughtShownAt = nowMs;
        }
        boolean showThought = thoughtMillis > 0 && nowMs - thoughtShownAt < thoughtMillis;
        ensureAttached(bot);
        if (display != null) display.text(render(lang, state, snapshot, showThought));
    }

    private void ensureAttached(Player bot) {
        if (display != null && display.isValid() && bot.getPassengers().contains(display)) return;
        remove();
        display = bot.getWorld().spawn(bot.getLocation(), TextDisplay.class, td -> {
            td.setPersistent(false);
            td.setBillboard(Display.Billboard.CENTER);
            td.setAlignment(TextDisplay.TextAlignment.CENTER);
            td.setLineWidth(220);
            td.setShadowed(true);
            td.setSeeThrough(false);
            td.setDefaultBackground(false);
            td.setBackgroundColor(Color.fromARGB(150, 20, 24, 30));
            td.setViewRange(0.6f);
            td.setTransformation(new Transformation(new Vector3f(0, height, 0), new AxisAngle4f(), new Vector3f(0.9f, 0.9f, 0.9f), new AxisAngle4f()));
            td.text(Component.text(lang.t("state.connecting"), Text.SLATE));
        });
        bot.addPassenger(display);
        bot.hideEntity(plugin, display);
    }

    public void remove() {
        if (display != null) {
            display.remove();
            display = null;
        }
    }

    public boolean isAttached() {
        return display != null && display.isValid();
    }

    /** The card's text. Pure: no world access, unit-tested. */
    public static Component render(Lang lang, MindLink.State state, MindSnapshot s, boolean showThought) {
        TextComponent.Builder b = Component.text();
        String name = s == null ? "EMETH" : s.name().toUpperCase(java.util.Locale.ROOT);
        b.append(Component.text("✦ " + name, Text.GOLD).decorate(TextDecoration.BOLD));
        if (s != null) b.append(Component.text(" · " + Text.label(lang, "stage", s.stage()), Text.SLATE));

        if (state == MindLink.State.UNAUTHORIZED) return b.append(Component.newline()).append(Component.text("⚠ " + lang.t("state.unauthorized"), Text.CLAY)).build();
        if (state != MindLink.State.ONLINE || s == null) {
            String key = state == MindLink.State.CONNECTING ? "state.connecting" : "holo.sleeping_mind";
            return b.append(Component.newline()).append(Component.text("☾ " + lang.t(key), Text.SLATE)).build();
        }

        String doing = s.action() != null ? s.action() : (!s.thought().intent().isBlank() ? s.thought().intent() : lang.t("holo.idle"));
        b.append(Component.newline()).append(Component.text(Text.actionIcon(doing) + " " + Text.truncate(doing, 42), Text.INK));

        if (showThought && !s.thought().reason().isBlank()) {
            List<String> lines = Text.wrap("« " + s.thought().reason() + " »", 40, 2);
            for (String line : lines) b.append(Component.newline()).append(Component.text(line, Text.SLATE).decorate(TextDecoration.ITALIC));
        }

        MindSnapshot.Threat t = s.threat();
        if (t != null && t.count() > 0) {
            String odds = "☠ " + Text.percent(t.danger()) + " ➜ " + Text.label(lang, "rec", t.recommendation());
            b.append(Component.newline()).append(Component.text(odds, Text.dangerColor(t.danger())));
        }
        if (s.reflection() != null && s.reflection().stuck()) {
            b.append(Component.newline()).append(Component.text("⟳ " + lang.t("hud.stuck"), Text.CLAY));
        }
        if (!s.languageMindAvailable()) {
            b.append(Component.newline()).append(Component.text("⚡ " + lang.t("state.instinct"), NamedTextColor.YELLOW));
        }
        return b.build();
    }
}
