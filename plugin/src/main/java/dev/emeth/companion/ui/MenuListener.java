package dev.emeth.companion.ui;

import java.util.function.BiConsumer;
import org.bukkit.entity.Player;
import org.bukkit.event.EventHandler;
import org.bukkit.event.Listener;
import org.bukkit.event.inventory.ClickType;
import org.bukkit.event.inventory.InventoryClickEvent;
import org.bukkit.event.inventory.InventoryDragEvent;

/** Routes clicks in the {@link MindMenu} to actions; nothing can be taken out of or put into the menu. */
public final class MenuListener implements Listener {
    private final BiConsumer<Player, Click> handler;

    public record Click(MenuModel.Action action, boolean right) {}

    public MenuListener(BiConsumer<Player, Click> handler) {
        this.handler = handler;
    }

    @EventHandler
    public void onClick(InventoryClickEvent event) {
        if (!(event.getView().getTopInventory().getHolder(false) instanceof MindMenu menu)) return;
        event.setCancelled(true);
        if (!(event.getWhoClicked() instanceof Player player)) return;
        if (event.getClickedInventory() != event.getView().getTopInventory()) return;
        MenuModel.Action action = menu.actionAt(event.getRawSlot());
        if (action != MenuModel.Action.NONE) handler.accept(player, new Click(action, event.getClick() == ClickType.RIGHT || event.getClick() == ClickType.SHIFT_RIGHT));
    }

    @EventHandler
    public void onDrag(InventoryDragEvent event) {
        if (event.getView().getTopInventory().getHolder(false) instanceof MindMenu) event.setCancelled(true);
    }
}
