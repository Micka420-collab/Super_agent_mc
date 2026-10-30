package dev.emeth.companion.ui;

import dev.emeth.companion.mind.MindException;
import dev.emeth.companion.mind.MindLink;
import io.papermc.paper.event.player.AsyncChatEvent;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.command.CommandSender;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.EventPriority;
import org.bukkit.event.Listener;
import org.bukkit.plugin.Plugin;

/**
 * The mentor's voice: advice and goal suggestions typed in chat (after a menu click) or with commands. Everything goes to
 * the mind's own {@code tell} / {@code set_goal}: the agent weighs it at its next thought and may decline. A per-player
 * cooldown protects the agent (each piece of advice wakes a thought, and thoughts cost tokens).
 */
public final class Mentor implements Listener {
    public enum Kind { TELL, GOAL }

    private record Pending(Kind kind, long expiresAt) {}

    private static final long PROMPT_MS = 60_000;

    private final Plugin plugin;
    private final Lang lang;
    private final Supplier<MindLink> link;
    private final Supplier<String> agentName;
    private final long cooldownMs;
    private final int maxLength;
    private final Map<UUID, Pending> pending = new ConcurrentHashMap<>();
    private final Map<String, Long> lastSent = new ConcurrentHashMap<>();

    public Mentor(Plugin plugin, Lang lang, Supplier<MindLink> link, Supplier<String> agentName, int cooldownSeconds, int maxLength) {
        this.plugin = plugin;
        this.lang = lang;
        this.link = link;
        this.agentName = agentName;
        this.cooldownMs = cooldownSeconds * 1000L;
        this.maxLength = maxLength;
    }

    /** Ask the player to type the advice / goal in chat. */
    public void ask(Player player, Kind kind) {
        pending.put(player.getUniqueId(), new Pending(kind, System.currentTimeMillis() + PROMPT_MS));
        player.sendMessage(Component.text("✎ " + lang.t(kind == Kind.TELL ? "prompt.tell" : "prompt.goal", agentName.get()), Text.GOLD));
    }

    public void forget(Player player) {
        pending.remove(player.getUniqueId());
    }

    @EventHandler(priority = EventPriority.LOWEST, ignoreCancelled = true)
    public void onChat(AsyncChatEvent event) {
        Player player = event.getPlayer();
        Pending p = pending.remove(player.getUniqueId());
        if (p == null || System.currentTimeMillis() > p.expiresAt()) return;
        event.setCancelled(true); // the advice is for the agent, not for the public chat
        String text = PlainTextComponentSerializer.plainText().serialize(event.message()).strip();
        if (text.equalsIgnoreCase(lang.t("prompt.cancel_word")) || text.equalsIgnoreCase("cancel")) {
            player.sendMessage(Component.text(lang.t("prompt.cancelled"), Text.SLATE));
            return;
        }
        submit(player, p.kind(), text);
    }

    /** Send advice or a goal on behalf of {@code sender}; replies on the main thread. */
    public void submit(CommandSender sender, Kind kind, String raw) {
        String text = Text.sanitize(raw, Integer.MAX_VALUE);
        int limit = kind == Kind.GOAL ? Math.min(200, maxLength) : maxLength;
        if (text.isEmpty()) return;
        if (text.length() > limit) {
            sender.sendMessage(Component.text(lang.t("cmd.too_long", limit), Text.CLAY));
            return;
        }
        long now = System.currentTimeMillis();
        Long last = lastSent.get(sender.getName());
        if (sender instanceof Player && last != null && now - last < cooldownMs) {
            sender.sendMessage(Component.text(lang.t("prompt.cooldown", (cooldownMs - (now - last) + 999) / 1000), Text.CLAY));
            return;
        }
        lastSent.put(sender.getName(), now);
        String source = Text.sanitize(sender.getName(), 24) + (sender instanceof Player ? " (in game)" : " (console)");
        MindLink l = link.get();
        var call = kind == Kind.TELL ? l.tell(text, source) : l.suggestGoal(text, "suggested in game by " + sender.getName(), source);
        call.whenComplete((ok, err) -> plugin.getServer().getScheduler().runTask(plugin, () -> {
            if (err != null) {
                sender.sendMessage(Component.text(lang.t("cmd.failed", MindException.of(err).getMessage()), Text.CLAY));
            } else if (kind == Kind.TELL) {
                sender.sendMessage(Component.text("✔ " + lang.t("cmd.told", agentName.get()), Text.SAGE));
            } else {
                sender.sendMessage(Component.text("✔ " + lang.t("cmd.goal_set", agentName.get(), text), Text.SAGE));
            }
        }));
    }
}
