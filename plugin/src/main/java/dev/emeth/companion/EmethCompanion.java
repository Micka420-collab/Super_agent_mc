package dev.emeth.companion;

import dev.emeth.companion.mind.Json;
import dev.emeth.companion.mind.MindClient;
import dev.emeth.companion.mind.MindException;
import dev.emeth.companion.mind.MindLink;
import dev.emeth.companion.mind.MindSnapshot;
import dev.emeth.companion.mind.TimelineEntry;
import dev.emeth.companion.mind.WebSocketTransport;
import dev.emeth.companion.ui.Announcer;
import dev.emeth.companion.ui.BookPager;
import dev.emeth.companion.ui.Hologram;
import dev.emeth.companion.ui.Hud;
import dev.emeth.companion.ui.Lang;
import dev.emeth.companion.ui.MenuListener;
import dev.emeth.companion.ui.MenuModel;
import dev.emeth.companion.ui.Mentor;
import dev.emeth.companion.ui.MindMenu;
import dev.emeth.companion.ui.Monitors;
import dev.emeth.companion.ui.RetinaImage;
import dev.emeth.companion.ui.Text;
import java.io.File;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import net.kyori.adventure.inventory.Book;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.command.PluginCommand;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.HandlerList;
import org.bukkit.event.Listener;
import org.bukkit.event.player.PlayerJoinEvent;
import org.bukkit.event.player.PlayerQuitEvent;
import org.bukkit.inventory.ItemStack;
import org.bukkit.plugin.java.JavaPlugin;
import org.bukkit.scheduler.BukkitTask;

/**
 * EMETH Companion — an in-game window into the mind of the EMETH agent, for the humans who play beside it.
 *
 * <p>It is a client of the mind's local control channel (ADR-0006), never of the body: it reads what the agent
 * perceives, feels, plans and thinks, and passes on advice through the mind's mentor methods. It does not move,
 * equip, teleport or otherwise help the bot (ADR-0007): the agent plays the same game as everyone else.
 */
public final class EmethCompanion extends JavaPlugin implements Listener {
    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault());

    private Settings settings;
    private Lang lang;
    private MindLink link;
    private Hologram hologram;
    private Hud hud;
    private Mentor mentor;
    private Monitors monitors;
    private Announcer announcer;
    private MenuListener menuListener;
    private final List<BukkitTask> tasks = new ArrayList<>();

    @Override
    public void onEnable() {
        saveDefaultConfig();
        try {
            start();
        } catch (IllegalArgumentException e) {
            getLogger().severe("configuration refused: " + e.getMessage());
            getServer().getPluginManager().disablePlugin(this);
            return;
        }
        PluginCommand command = Objects.requireNonNull(getCommand("emeth"), "plugin.yml declares /emeth");
        EmethCommand executor = new EmethCommand(this);
        command.setExecutor(executor);
        command.setTabCompleter(executor);
        getServer().getPluginManager().registerEvents(this, this);
    }

    @Override
    public void onDisable() {
        stop();
    }

    private void start() {
        reloadConfig();
        settings = Settings.from(getConfig(), Path.of("").toAbsolutePath(), System.getenv());
        for (String w : settings.warnings()) getLogger().warning(w);
        lang = Lang.of(settings.language());
        MindClient client = new MindClient(settings.mindUrl(), settings.token(), WebSocketTransport.connector(Duration.ofSeconds(5)), Duration.ofSeconds(settings.timeoutSeconds()));
        link = new MindLink(client, r -> getServer().getScheduler().runTask(this, r), getLogger(), System::currentTimeMillis);
        link.onUpdate(this::onUpdate);
        getLogger().info("watching the mind at " + link.endpoint() + " (token from " + settings.tokenSource() + ")");

        hologram = new Hologram(this, lang, settings.hologramHeight(), settings.thoughtSeconds());
        hud = new Hud(this, lang, settings.sidebar(), settings.bossbar(), settings.actionbar());
        mentor = new Mentor(this, lang, () -> link, this::agentName, settings.mentorCooldownSeconds(), settings.mentorMaxLength());
        announcer = new Announcer(lang, settings.announceKinds(), settings.stuckAlert());
        monitors = new Monitors(lang, new File(getDataFolder(), "monitors.yml"), getLogger());
        monitors.load();
        menuListener = new MenuListener((player, click) -> onMenuClick(player, click));
        getServer().getPluginManager().registerEvents(mentor, this);
        getServer().getPluginManager().registerEvents(menuListener, this);
        for (Player p : Bukkit.getOnlinePlayers()) hud.restore(p, settings.hudOnJoin());

        long poll = settings.pollSeconds() * 20L;
        tasks.add(getServer().getScheduler().runTaskTimerAsynchronously(this, () -> link.poll(), 20L, poll));
        long refresh = settings.monitorRefreshSeconds() * 20L;
        tasks.add(getServer().getScheduler().runTaskTimerAsynchronously(this, this::refreshMonitors, 40L, refresh));
    }

    private void stop() {
        for (BukkitTask t : tasks) t.cancel();
        tasks.clear();
        if (mentor != null) HandlerList.unregisterAll(mentor);
        if (menuListener != null) HandlerList.unregisterAll(menuListener);
        if (hologram != null) hologram.remove();
        if (hud != null) hud.shutdown();
        if (monitors != null) monitors.save();
        if (link != null) link.close();
    }

    void reload() {
        stop();
        start();
    }

    // --- the loop: one update per poll, on the main thread ------------------------------------
    private void onUpdate(MindLink.Update u) {
        MindSnapshot s = u.snapshot();
        Player bot = findBot(s);
        if (settings.hologram()) hologram.update(bot, u.state(), s, System.currentTimeMillis());
        hud.update(u.state(), s);
        for (Player p : Bukkit.getOnlinePlayers()) {
            if (p.getOpenInventory().getTopInventory().getHolder(false) instanceof MindMenu menu) menu.render(menuModel(p), bot);
        }
        List<Player> audience = settings.announceToAll() ? new ArrayList<>(Bukkit.getOnlinePlayers()) : hud.followers();
        List<Player> mentors = new ArrayList<>();
        for (Player p : Bukkit.getOnlinePlayers()) if (p.hasPermission("emeth.mentor") && (settings.announceToAll() || hud.isFollowing(p))) mentors.add(p);
        announcer.handle(u, audience, mentors);
        monitors.caption(monitorHeaders(s), monitorFooters(u.state(), s));
    }

    private void refreshMonitors() {
        if (link.state() != MindLink.State.ONLINE || Bukkit.getOnlinePlayers().isEmpty()) return;
        for (int width : new int[] {1, 2}) {
            if (!monitors.wants(width)) continue;
            int[] size = RetinaImage.requestSize(width);
            link.render(size[0], size[1]).thenAccept(r -> monitors.accept(width, RetinaImage.decode(Json.str(r, "pngBase64", null))))
                    .exceptionally(err -> null);
        }
    }

    private String[] monitorHeaders(MindSnapshot s) {
        String title = lang.t("monitor.title");
        if (s == null || s.vitals() == null) return new String[] {title, ""};
        MindSnapshot.Vitals v = s.vitals();
        String where = "Y " + Math.round(v.y()) + "  " + Text.label(lang, "phase", v.phase()) + " " + v.day();
        return new String[] {title, where};
    }

    private String[] monitorFooters(MindLink.State state, MindSnapshot s) {
        if (state != MindLink.State.ONLINE || s == null) return new String[] {lang.t("state.offline"), ""};
        String doing = s.action() != null ? s.action() : s.thought().intent();
        MindSnapshot.Threat t = s.threat();
        String odds = t.count() > 0 ? Text.percent(t.danger()) + " " + Text.label(lang, "rec", t.recommendation()) : Text.label(lang, "rec", "calm");
        return new String[] {doing == null || doing.isBlank() ? lang.t("holo.idle") : doing, odds};
    }

    Player findBot(MindSnapshot s) {
        String name = !settings.botUsername().isBlank() ? settings.botUsername() : s == null ? null : s.username();
        return name == null ? null : Bukkit.getPlayerExact(name);
    }

    String agentName() {
        MindSnapshot s = link == null ? null : link.latest();
        return s == null ? "Emeth" : s.name();
    }

    // --- actions used by the command and the menu ----------------------------------------------
    Lang lang() {
        return lang;
    }

    MindLink link() {
        return link;
    }

    Mentor mentor() {
        return mentor;
    }

    Hud hud() {
        return hud;
    }

    Monitors monitors() {
        return monitors;
    }

    MenuModelInput menuModelInput(Player p) {
        return new MenuModelInput(link.state(), link.latest(), p.hasPermission("emeth.mentor"), p.hasPermission("emeth.monitor"), hud.isFollowing(p));
    }

    record MenuModelInput(MindLink.State state, MindSnapshot snapshot, boolean canMentor, boolean canMonitor, boolean hudOn) {}

    private Map<Integer, MenuModel.Slot> menuModel(Player p) {
        MenuModelInput in = menuModelInput(p);
        return MenuModel.build(lang, in.state(), in.snapshot(), in.canMentor(), in.canMonitor(), in.hudOn());
    }

    void openMenu(Player p) {
        MindMenu menu = new MindMenu(Component.text(lang.t("menu.title", agentName()), Text.GOLD));
        menu.render(menuModel(p), findBot(link.latest()));
        p.openInventory(menu.getInventory());
    }

    private void onMenuClick(Player p, MenuListener.Click click) {
        switch (click.action()) {
            case CLOSE -> p.closeInventory();
            case GOALS -> {
                p.closeInventory();
                openGoals(p);
            }
            case JOURNAL -> {
                p.closeInventory();
                openJournal(p);
            }
            case MONITOR -> {
                p.closeInventory();
                giveMonitor(p, click.right() ? 2 : 1);
            }
            case TELL -> {
                p.closeInventory();
                mentor.ask(p, Mentor.Kind.TELL);
            }
            case GOAL -> {
                p.closeInventory();
                mentor.ask(p, Mentor.Kind.GOAL);
            }
            case HUD -> {
                toggleHud(p);
                if (p.getOpenInventory().getTopInventory().getHolder(false) instanceof MindMenu menu) menu.render(menuModel(p), findBot(link.latest()));
            }
            case NONE -> { }
        }
    }

    void toggleHud(Player p) {
        boolean on = hud.toggle(p);
        p.sendMessage(Component.text(lang.t(on ? "hud.on" : "hud.off"), on ? Text.SAGE : Text.SLATE));
        if (on) hud.update(link.state(), link.latest());
    }

    void giveMonitor(Player p, int width) {
        List<ItemStack> items = monitors.create(p.getWorld(), width);
        var leftovers = p.getInventory().addItem(items.toArray(new ItemStack[0]));
        for (ItemStack rest : leftovers.values()) p.getWorld().dropItem(p.getLocation(), rest);
        p.sendMessage(Component.text(lang.t(width == 1 ? "cmd.monitor_given" : "cmd.wall_given"), Text.SAGE));
        refreshMonitors();
    }

    void openGoals(Player p) {
        String name = agentName();
        link.goals().whenComplete((r, err) -> runSync(() -> {
            if (err != null) {
                p.sendMessage(Component.text(lang.t("cmd.failed", MindException.of(err).getMessage()), Text.CLAY));
                return;
            }
            List<String> paragraphs = new ArrayList<>();
            for (String line : Json.str(r, "text", "").split("\n")) paragraphs.add(line);
            openBook(p, lang.t("book.goals", name), name, paragraphs);
        }));
    }

    void openJournal(Player p) {
        String name = agentName();
        link.timeline(80).whenComplete((r, err) -> runSync(() -> {
            if (err != null) {
                p.sendMessage(Component.text(lang.t("cmd.failed", MindException.of(err).getMessage()), Text.CLAY));
                return;
            }
            openBook(p, lang.t("book.journal", name), name, journalParagraphs(TimelineEntry.parseAll(r)));
        }));
    }

    static List<String> journalParagraphs(List<TimelineEntry> entries) {
        List<String> paragraphs = new ArrayList<>();
        List<TimelineEntry> newestFirst = new ArrayList<>(entries);
        java.util.Collections.reverse(newestFirst);
        for (TimelineEntry e : newestFirst) {
            String when = e.ts() > 0 ? CLOCK.format(Instant.ofEpochMilli((long) (e.ts() * 1000))) + " " : "";
            paragraphs.add(when + e.kind().toUpperCase(Locale.ROOT) + (e.count() > 1 ? " ×" + e.count() : ""));
            paragraphs.add(e.text());
            paragraphs.add("");
        }
        return paragraphs;
    }

    private void openBook(Player p, String title, String author, List<String> paragraphs) {
        List<Component> pages = new ArrayList<>();
        for (String page : BookPager.paginate(paragraphs)) pages.add(Component.text(page));
        p.openBook(Book.book(Component.text(title), Component.text(author), pages));
    }

    void say(org.bukkit.command.CommandSender sender, String text) {
        link.say(Text.sanitize(text, 240)).whenComplete((ok, err) -> runSync(() -> sender.sendMessage(err == null
                ? Component.text("✔ " + lang.t("cmd.said", agentName()), Text.SAGE)
                : Component.text(lang.t("cmd.failed", MindException.of(err).getMessage()), Text.CLAY))));
    }

    void runSync(Runnable r) {
        getServer().getScheduler().runTask(this, r);
    }

    /** A plain-text status for the console and chat. */
    List<String> statusLines() {
        List<String> out = new ArrayList<>();
        MindSnapshot s = link.latest();
        out.add("EMETH · " + link.state().name().toLowerCase(Locale.ROOT) + " · " + link.endpoint() + (link.lastError().isBlank() ? "" : " · " + link.lastError()));
        if (s == null) return out;
        out.add(s.name() + " · " + Text.label(lang, "stage", s.stage()) + " · " + s.decisions() + " decisions · " + (s.bodyConnected() ? "body ok" : "body off") + (s.languageMindAvailable() ? "" : " · instinct"));
        if (s.vitals() != null) {
            MindSnapshot.Vitals v = s.vitals();
            out.add("HP " + Math.round(v.health()) + " · food " + Math.round(v.food()) + " · " + v.dimension() + " " + Text.coords(v.x(), v.y(), v.z()) + " · " + Text.label(lang, "phase", v.phase()) + " " + v.day());
        }
        if (s.task() != null) out.add(lang.t("hud.task") + " : " + s.task());
        if (s.action() != null) out.add(lang.t("menu.action", s.action()));
        if (!s.thought().reason().isBlank()) out.add(lang.t("hud.thought") + " : " + s.thought().reason());
        out.add(lang.t("hud.danger") + " : " + Text.percent(s.threat().danger()) + " " + Text.label(lang, "rec", s.threat().recommendation()));
        Player bot = findBot(s);
        out.add("hologram " + (hologram.isAttached() ? "attached to " + (bot == null ? "?" : bot.getName()) : "detached") + " · monitors " + monitors.count() + " · HUD " + hud.followers().size());
        return out;
    }

    // --- players coming and going ---------------------------------------------------------------
    @EventHandler
    public void onJoin(PlayerJoinEvent event) {
        hud.restore(event.getPlayer(), settings.hudOnJoin());
    }

    @EventHandler
    public void onQuit(PlayerQuitEvent event) {
        hud.forget(event.getPlayer());
        mentor.forget(event.getPlayer());
        MindSnapshot s = link.latest();
        if (s != null && event.getPlayer().getName().equals(findBotName(s))) hologram.remove();
    }

    private String findBotName(MindSnapshot s) {
        return !settings.botUsername().isBlank() ? settings.botUsername() : s.username();
    }
}
