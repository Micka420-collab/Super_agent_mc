package dev.emeth.companion.ui;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.google.gson.JsonObject;
import dev.emeth.companion.Fixtures;
import dev.emeth.companion.mind.MindLink;
import dev.emeth.companion.mind.MindSnapshot;
import java.util.List;
import java.util.Map;
import net.kyori.adventure.text.Component;
import net.kyori.adventure.text.serializer.plain.PlainTextComponentSerializer;
import org.bukkit.Material;
import org.junit.jupiter.api.Test;

/** The hologram card, the HUD lines and the menu model, rendered from the mind's real status fixture. */
class RenderersTest {
    private static final Lang FR = Lang.of("fr");
    private static final MindSnapshot S = MindSnapshot.parse(Fixtures.load("status.json"));

    private static String plain(Component c) {
        return PlainTextComponentSerializer.plainText().serialize(c);
    }

    @Test
    void hologramShowsNameStageActionThoughtAndOdds() {
        String card = plain(Hologram.render(FR, MindLink.State.ONLINE, S, true));
        String[] lines = card.split("\n");
        assertEquals("✦ EMETH · nouveau-né", lines[0]);
        assertTrue(lines[1].startsWith("● look_at_player"), lines[1]);
        assertEquals("« greet »", lines[2]);
        assertEquals("☠ 33% ➜ combattre", lines[3]);
        assertFalse(card.contains("instinct"));
        String noThought = plain(Hologram.render(FR, MindLink.State.ONLINE, S, false));
        assertFalse(noThought.contains("greet"));
        assertTrue(plain(Hologram.render(FR, MindLink.State.OFFLINE, S, true)).contains("l'esprit dort"));
        assertTrue(plain(Hologram.render(FR, MindLink.State.UNAUTHORIZED, null, true)).contains("jeton refusé"));
        assertTrue(plain(Hologram.render(Lang.of("en"), MindLink.State.CONNECTING, null, true)).contains("connecting to the mind"));
    }

    @Test
    void hudLinesCarryGoalLadderVitalsOddsAndThought() {
        String boss = plain(Hud.bossTitle(FR, MindLink.State.ONLINE, S));
        assertEquals("Emeth · But : Punch a tree and collect 6 logs · Échelle 2/21", boss);
        String bar = plain(Hud.actionBar(FR, MindLink.State.ONLINE, S));
        assertTrue(bar.startsWith("❤ 17 ✚ 13 ☀ jour 3"), bar);
        assertTrue(bar.contains("☠ 33% combattre"), bar);
        List<Component> side = Hud.sidebar(FR, MindLink.State.ONLINE, S);
        assertTrue(side.size() <= 14);
        String all = String.join("\n", side.stream().map(RenderersTest::plain).toList());
        assertTrue(all.startsWith("✦ EMETH · nouveau-né"), all);
        assertTrue(all.contains("Humeur : joyeux"), all);
        assertTrue(all.contains("Ordre"), "the strongest drive (order 0.5) is listed: " + all);
        assertTrue(all.contains("Danger : 33% · combattre"), all);
        assertTrue(all.contains("Tâche :") && all.contains("Pensée :") && all.contains("greet"), all);
        assertEquals("EMETH · esprit injoignable", plain(Hud.bossTitle(FR, MindLink.State.OFFLINE, S)));
    }

    @Test
    void menuModelLaysOutTheMindAndGuardsMentorActions() {
        Map<Integer, MenuModel.Slot> mentor = MenuModel.build(FR, MindLink.State.ONLINE, S, true, true, false);
        assertEquals(Material.PLAYER_HEAD, mentor.get(MenuModel.HEAD).material());
        assertEquals("Emeth · nouveau-né", mentor.get(MenuModel.HEAD).name());
        assertTrue(mentor.get(MenuModel.HEAD).lore().contains("Joueurs proches : Steve"));
        assertEquals(Material.SHIELD, mentor.get(MenuModel.DRIVES[0]).material());
        assertEquals(Material.IRON_SWORD, mentor.get(MenuModel.ODDS).material(), "recommendation fight");
        assertEquals(MenuModel.Action.TELL, mentor.get(MenuModel.TELL).action());
        assertEquals(MenuModel.Action.GOAL, mentor.get(MenuModel.GOAL).action());
        assertEquals(MenuModel.Action.MONITOR, mentor.get(MenuModel.MONITOR).action());
        assertTrue(mentor.get(MenuModel.THINKING).lore().getFirst().contains("greet"));
        assertTrue(mentor.get(MenuModel.LADDER).lore().getFirst().startsWith("2/21 jalons"));
        for (MenuModel.Slot slot : mentor.values()) assertTrue(slot.amount() >= 1 && slot.amount() <= 64);

        Map<Integer, MenuModel.Slot> visitor = MenuModel.build(FR, MindLink.State.ONLINE, S, false, false, true);
        assertEquals(MenuModel.Action.NONE, visitor.get(MenuModel.TELL).action(), "visitors cannot advise");
        assertTrue(visitor.get(MenuModel.TELL).lore().contains("Réservé aux mentors (emeth.mentor)."));
        assertFalse(visitor.containsKey(MenuModel.MONITOR));
        assertTrue(visitor.get(MenuModel.HUD).glint());

        Map<Integer, MenuModel.Slot> offline = MenuModel.build(FR, MindLink.State.OFFLINE, null, true, true, false);
        assertEquals(List.of("esprit injoignable"), offline.get(MenuModel.HEAD).lore());
        assertEquals(MenuModel.Action.CLOSE, offline.get(MenuModel.CLOSE).action());
        assertFalse(offline.containsKey(MenuModel.TELL));
    }

    @Test
    void stuckAgentShowsUpEverywhere() {
        JsonObject status = Fixtures.load("status.json").getAsJsonObject().deepCopy();
        JsonObject r = status.getAsJsonObject("reflection");
        r.addProperty("stuck", true);
        com.google.gson.JsonArray same = new com.google.gson.JsonArray();
        same.add("mine({\"name\": \"diamond_ore\"})");
        same.add("NOT_FOUND");
        same.add(3);
        r.add("same_failure", same);
        MindSnapshot stuck = MindSnapshot.parse(status);
        assertTrue(plain(Hologram.render(FR, MindLink.State.ONLINE, stuck, false)).contains("⟳ tourne en rond"));
        Map<Integer, MenuModel.Slot> model = MenuModel.build(FR, MindLink.State.ONLINE, stuck, true, true, false);
        assertTrue(model.get(MenuModel.REFLECTION).glint());
        assertEquals("Il tourne en rond !", model.get(MenuModel.REFLECTION).lore().getFirst());
    }
}
