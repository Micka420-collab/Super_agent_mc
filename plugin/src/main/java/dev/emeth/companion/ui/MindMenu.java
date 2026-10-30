package dev.emeth.companion.ui;

import java.util.Map;
import net.kyori.adventure.text.Component;
import org.bukkit.Bukkit;
import org.bukkit.inventory.Inventory;
import org.bukkit.inventory.InventoryHolder;
import org.bukkit.inventory.ItemFlag;
import org.bukkit.inventory.ItemStack;
import org.bukkit.inventory.meta.ItemMeta;
import org.bukkit.inventory.meta.SkullMeta;
import org.bukkit.entity.Player;

/** The chest-style "inside its head" window. A view only: every click is cancelled and routed by {@link MenuListener}. */
public final class MindMenu implements InventoryHolder {
    private final Inventory inventory;
    private Map<Integer, MenuModel.Slot> slots = Map.of();

    public MindMenu(Component title) {
        this.inventory = Bukkit.createInventory(this, MenuModel.SIZE, title);
    }

    @Override
    public Inventory getInventory() {
        return inventory;
    }

    public MenuModel.Action actionAt(int slot) {
        MenuModel.Slot s = slots.get(slot);
        return s == null ? MenuModel.Action.NONE : s.action();
    }

    /** Fill (or refill, while open) from a model; {@code bot} gives the head its skin when the agent is online. */
    public void render(Map<Integer, MenuModel.Slot> model, Player bot) {
        this.slots = model;
        for (int i = 0; i < MenuModel.SIZE; i++) {
            MenuModel.Slot s = model.get(i);
            inventory.setItem(i, s == null ? null : stack(s, i == MenuModel.HEAD ? bot : null));
        }
    }

    private static ItemStack stack(MenuModel.Slot s, Player headOwner) {
        ItemStack item = new ItemStack(s.material(), Math.max(1, Math.min(64, s.amount())));
        ItemMeta meta = item.getItemMeta();
        if (meta == null) return item;
        meta.displayName(Text.plain(s.name(), s.color()));
        if (!s.lore().isEmpty()) meta.lore(Text.lore(s.lore(), Text.SLATE));
        if (s.glint()) meta.setEnchantmentGlintOverride(true);
        meta.addItemFlags(ItemFlag.values());
        if (headOwner != null && meta instanceof SkullMeta skull) skull.setOwningPlayer(headOwner);
        item.setItemMeta(meta);
        return item;
    }
}
