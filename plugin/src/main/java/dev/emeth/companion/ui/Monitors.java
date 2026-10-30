package dev.emeth.companion.ui;

import java.awt.image.BufferedImage;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicLong;
import java.util.logging.Logger;
import org.bukkit.Bukkit;
import org.bukkit.Material;
import org.bukkit.World;
import org.bukkit.configuration.file.YamlConfiguration;
import org.bukkit.entity.Player;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.MapMeta;
import org.bukkit.map.MapCanvas;
import org.bukkit.map.MapRenderer;
import org.bukkit.map.MapView;

/**
 * Retina monitors: map items that show what the agent's eyes see (the body's ray-cast retina), refreshed every few
 * seconds. One map is a screen; two side by side in item frames make a 2×1 wall with twice the resolution. The map
 * ids are remembered in {@code monitors.yml} so placed monitors keep working after a restart.
 */
public final class Monitors {
    private final Lang lang;
    private final File store;
    private final Logger log;
    private final List<Tile> tiles = new ArrayList<>();

    /** Latest frames, by monitor width (1 or 2 tiles). Replaced atomically; renderers compare versions. */
    private volatile BufferedImage[] single;
    private volatile BufferedImage[] wall;
    private volatile String[] headers = {"", ""};
    private volatile String[] footers = {"", ""};
    private final AtomicLong version = new AtomicLong();

    private static final int GOLD_RGB = 0xE0B04B;
    private static final int INK_RGB = 0xE8E3D8;

    private record Tile(MapView view, int width, int index) {}

    public Monitors(Lang lang, File store, Logger log) {
        this.lang = lang;
        this.store = store;
        this.log = log;
    }

    /** Re-attach renderers to the maps created in earlier sessions. Main thread. */
    public void load() {
        if (!store.exists()) return;
        YamlConfiguration yml = YamlConfiguration.loadConfiguration(store);
        for (String entry : yml.getStringList("tiles")) {
            String[] parts = entry.split(":");
            if (parts.length != 3) continue;
            try {
                MapView view = Bukkit.getMap(Integer.parseInt(parts[0]));
                if (view != null) attach(view, Integer.parseInt(parts[1]), Integer.parseInt(parts[2]));
            } catch (NumberFormatException e) {
                log.warning("monitors.yml: ignoring malformed entry " + entry);
            }
        }
    }

    public void save() {
        YamlConfiguration yml = new YamlConfiguration();
        List<String> out = new ArrayList<>();
        for (Tile t : tiles) out.add(t.view().getId() + ":" + t.width() + ":" + t.index());
        yml.set("tiles", out);
        try {
            yml.save(store);
        } catch (IOException e) {
            log.warning("cannot save " + store + ": " + e.getMessage());
        }
    }

    /** New monitor of {@code width} tiles (1 or 2), as map items ready for item frames. Main thread. */
    public List<ItemStack> create(World world, int width) {
        List<ItemStack> items = new ArrayList<>();
        for (int i = 0; i < width; i++) {
            MapView view = Bukkit.createMap(world);
            attach(view, width, i);
            ItemStack item = new ItemStack(Material.FILLED_MAP);
            MapMeta meta = (MapMeta) item.getItemMeta();
            meta.setMapView(view);
            String part = width == 1 ? "" : (i == 0 ? " ◀" : " ▶");
            meta.displayName(Text.plain(lang.t("menu.monitor") + part, Text.GOLD));
            meta.lore(Text.lore(Text.wrap(lang.t("menu.monitor.lore"), 40, 3), Text.SLATE));
            item.setItemMeta(meta);
            items.add(item);
        }
        save();
        return items;
    }

    private void attach(MapView view, int width, int index) {
        for (MapRenderer r : new ArrayList<>(view.getRenderers())) view.removeRenderer(r);
        view.setScale(MapView.Scale.CLOSEST);
        view.setTrackingPosition(false);
        view.setUnlimitedTracking(false);
        view.addRenderer(new Renderer(width, index));
        tiles.add(new Tile(view, width, index));
    }

    public boolean wants(int width) {
        for (Tile t : tiles) if (t.width() == width) return true;
        return false;
    }

    public int count() {
        return tiles.size();
    }

    /** A new retina frame for monitors of {@code width} tiles. Any thread. */
    public void accept(int width, BufferedImage retina) {
        BufferedImage[] split = RetinaImage.split(RetinaImage.compose(retina, width));
        if (width == 1) single = split;
        else wall = split;
        version.incrementAndGet();
    }

    /** Text bands: per tile header and footer (ASCII only — the map font has no accents). Any thread. */
    public void caption(String[] newHeaders, String[] newFooters) {
        headers = newHeaders.clone();
        footers = newFooters.clone();
        version.incrementAndGet();
    }

    private final class Renderer extends MapRenderer {
        private final int width;
        private final int index;
        private long drawn = -1;

        Renderer(int width, int index) {
            super(false);
            this.width = width;
            this.index = index;
        }

        @Override
        public void render(MapView view, MapCanvas canvas, Player player) {
            long v = version.get();
            if (v == drawn) return;
            drawn = v;
            BufferedImage[] frames = width == 1 ? single : wall;
            BufferedImage tile = frames != null && index < frames.length ? frames[index] : RetinaImage.split(RetinaImage.compose(null, width))[index];
            String header = index < headers.length ? headers[index] : "";
            String footer = index < footers.length ? footers[index] : "";
            if (frames == null && index == 0) footer = lang.t("monitor.wait");
            canvas.drawImage(0, 0, RetinaImage.caption(tile, header, footer, GOLD_RGB, INK_RGB));
        }
    }
}
