package dev.emeth.companion;

import dev.emeth.companion.ui.Mentor;
import dev.emeth.companion.ui.Text;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;
import net.kyori.adventure.text.Component;
import org.bukkit.command.Command;
import org.bukkit.command.CommandSender;
import org.bukkit.command.TabExecutor;
import org.bukkit.entity.Player;

/** {@code /emeth} — menu, status, HUD, books, monitors, and the mentor's voice. */
final class EmethCommand implements TabExecutor {
    private static final List<String> SUBCOMMANDS = List.of("menu", "status", "hud", "tell", "goal", "goals", "journal", "monitor", "say", "reload");

    private final EmethCompanion plugin;

    EmethCommand(EmethCompanion plugin) {
        this.plugin = plugin;
    }

    @Override
    public boolean onCommand(CommandSender sender, Command command, String label, String[] args) {
        String sub = args.length == 0 ? "menu" : args[0].toLowerCase(Locale.ROOT);
        String rest = String.join(" ", Arrays.copyOfRange(args, Math.min(1, args.length), args.length)).strip();
        switch (sub) {
            case "menu" -> {
                Player p = player(sender);
                if (p != null && allowed(sender, "emeth.use")) plugin.openMenu(p);
            }
            case "status" -> {
                if (allowed(sender, "emeth.use")) for (String line : plugin.statusLines()) sender.sendMessage(Component.text(line, Text.INK));
            }
            case "hud" -> {
                Player p = player(sender);
                if (p != null && allowed(sender, "emeth.use")) plugin.toggleHud(p);
            }
            case "goals" -> {
                Player p = player(sender);
                if (p != null && allowed(sender, "emeth.use")) plugin.openGoals(p);
            }
            case "journal" -> {
                Player p = player(sender);
                if (p != null && allowed(sender, "emeth.use")) plugin.openJournal(p);
            }
            case "tell" -> {
                if (!allowed(sender, "emeth.mentor")) return true;
                if (rest.isEmpty()) return usage(sender, "/emeth tell <conseil>");
                plugin.mentor().submit(sender, Mentor.Kind.TELL, rest);
            }
            case "goal" -> {
                if (!allowed(sender, "emeth.mentor")) return true;
                if (rest.isEmpty()) return usage(sender, "/emeth goal <but>");
                plugin.mentor().submit(sender, Mentor.Kind.GOAL, rest);
            }
            case "say" -> {
                if (!allowed(sender, "emeth.admin")) return true;
                if (rest.isEmpty()) return usage(sender, "/emeth say <texte>");
                plugin.say(sender, rest);
            }
            case "monitor" -> {
                Player p = player(sender);
                if (p != null && allowed(sender, "emeth.monitor")) plugin.giveMonitor(p, rest.equalsIgnoreCase("wall") || rest.equals("2") ? 2 : 1);
            }
            case "reload" -> {
                if (!allowed(sender, "emeth.admin")) return true;
                plugin.reload();
                sender.sendMessage(Component.text(plugin.lang().t("cmd.reloaded"), Text.SAGE));
            }
            default -> sender.sendMessage(Component.text(plugin.lang().t("cmd.usage"), Text.SLATE));
        }
        return true;
    }

    private boolean usage(CommandSender sender, String usage) {
        sender.sendMessage(Component.text(usage, Text.SLATE));
        return true;
    }

    private Player player(CommandSender sender) {
        if (sender instanceof Player p) return p;
        sender.sendMessage(Component.text(plugin.lang().t("cmd.players_only"), Text.CLAY));
        return null;
    }

    private boolean allowed(CommandSender sender, String permission) {
        if (sender.hasPermission(permission)) return true;
        sender.sendMessage(Component.text(plugin.lang().t("cmd.no_permission", permission), Text.CLAY));
        return false;
    }

    @Override
    public List<String> onTabComplete(CommandSender sender, Command command, String alias, String[] args) {
        if (args.length == 1) {
            List<String> out = new ArrayList<>();
            for (String s : SUBCOMMANDS) if (s.startsWith(args[0].toLowerCase(Locale.ROOT))) out.add(s);
            return out;
        }
        if (args.length == 2 && args[0].equalsIgnoreCase("monitor")) return List.of("1", "wall");
        return List.of();
    }
}
