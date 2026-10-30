package dev.emeth.companion.ui;

import java.util.HashMap;
import java.util.Map;

/** Interface strings, French by default (the project's language), English available ({@code language: en}). */
public final class Lang {
    private static final Map<String, String> FR = new HashMap<>();
    private static final Map<String, String> EN = new HashMap<>();

    static {
        put("stage.newborn", "nouveau-né", "newborn");
        put("stage.apprentice", "apprenti", "apprentice");
        put("stage.survivor", "survivant", "survivor");
        put("stage.builder", "bâtisseur", "builder");
        put("stage.citizen", "citoyen", "citizen");
        put("stage.awakened", "éveillé", "awakened");

        put("rec.calm", "calme", "calm");
        put("rec.watch", "aux aguets", "watchful");
        put("rec.fight", "combattre", "fight");
        put("rec.retreat", "reculer", "back off");
        put("rec.flee", "fuir", "run");

        put("phase.dawn", "aube", "dawn");
        put("phase.day", "jour", "day");
        put("phase.dusk", "crépuscule", "dusk");
        put("phase.night", "nuit", "night");

        put("drive.safety", "Sécurité", "Safety");
        put("drive.hunger", "Faim", "Hunger");
        put("drive.rest", "Repos", "Rest");
        put("drive.curiosity", "Curiosité", "Curiosity");
        put("drive.social", "Compagnie", "Company");
        put("drive.mastery", "Accomplissement", "Mastery");
        put("drive.order", "Ordre", "Order");

        put("mood.cheerful", "joyeux", "cheerful");
        put("mood.content", "serein", "content");
        put("mood.uneasy", "inquiet", "uneasy");
        put("mood.miserable", "malheureux", "miserable");

        put("state.offline", "esprit injoignable", "mind unreachable");
        put("state.unauthorized", "jeton refusé par l'esprit", "token refused by the mind");
        put("state.connecting", "connexion à l'esprit…", "connecting to the mind…");
        put("state.body_off", "corps déconnecté", "body disconnected");
        put("state.instinct", "instinct (aucun modèle ne répond)", "instinct (no language model answers)");

        put("holo.idle", "au repos", "idle");
        put("holo.sleeping_mind", "l'esprit dort", "the mind is asleep");

        put("hud.goal", "But", "Goal");
        put("hud.ladder", "Échelle", "Ladder");
        put("hud.no_goal", "aucun but en cours", "no goal right now");
        put("hud.danger", "Danger", "Danger");
        put("hud.mood", "Humeur", "Mood");
        put("hud.task", "Tâche", "Task");
        put("hud.thought", "Pensée", "Thought");
        put("hud.stuck", "tourne en rond", "going in circles");
        put("hud.on", "Affichage d'Emeth activé. /emeth hud pour le masquer.", "Emeth HUD on. /emeth hud to hide it.");
        put("hud.off", "Affichage d'Emeth masqué.", "Emeth HUD hidden.");

        put("menu.title", "Dans la tête de {0}", "Inside {0}'s head");
        put("menu.status", "{0} · {1}", "{0} · {1}");
        put("menu.level", "Autonomie {0} · expérience {1}", "Autonomy {0} · experience {1}");
        put("menu.where", "{0}, jour {1} ({2}) · {3} {4} {5}", "{0}, day {1} ({2}) · {3} {4} {5}");
        put("menu.vitals", "Vie {0}/20 · Faim {1}/20 · niveau {2}", "Health {0}/20 · Food {1}/20 · level {2}");
        put("menu.mind_on", "Esprit : en ligne ({0} décisions)", "Mind: online ({0} decisions)");
        put("menu.thinking", "Ce qu'il pense", "What it thinks");
        put("menu.doing", "Ce qu'il fait", "What it does");
        put("menu.odds", "Rapport de force", "The odds");
        put("menu.reflection", "Réflexion", "Reflection");
        put("menu.reflection.ok", "Il avance sans tourner en rond.", "Moving on, no loop.");
        put("menu.reflection.stuck", "Il tourne en rond !", "Going in circles!");
        put("menu.failure_rate", "Échecs récents : {0}", "Recent failures: {0}");
        put("menu.goals", "Objectifs", "Goals");
        put("menu.journal", "Journal", "Journal");
        put("menu.monitor", "Moniteur rétine", "Retina monitor");
        put("menu.monitor.lore", "Ce que voient ses yeux, sur une carte. Clic : 1 écran · clic droit : mur 2×1", "What its eyes see, on a map. Click: 1 screen · right click: 2×1 wall");
        put("menu.ladder", "Échelle de survie", "Survival ladder");
        put("menu.ladder.lore", "{0}/{1} jalons · prochain : {2}", "{0}/{1} milestones · next: {2}");
        put("menu.tell", "Lui parler à l'oreille", "Whisper advice");
        put("menu.tell.lore", "Un conseil qu'il pèsera à sa prochaine pensée. Il décide.", "Advice it will weigh at its next thought. It decides.");
        put("menu.goal", "Proposer un but", "Suggest a goal");
        put("menu.goal.lore", "Un but qu'il peut accepter ou abandonner avec une raison.", "A goal it may take up or drop with a reason.");
        put("menu.hud", "Affichage tête haute", "Heads-up display");
        put("menu.hud.lore", "Barre de but, état et pensées en permanence.", "Goal bar, state and thoughts at all times.");
        put("menu.hud.state.on", "affiché", "shown");
        put("menu.hud.state.off", "masqué", "hidden");
        put("menu.close", "Fermer", "Close");
        put("menu.mentor_only", "Réservé aux mentors (emeth.mentor).", "Mentors only (emeth.mentor).");
        put("menu.click", "▶ Cliquer", "▶ Click");
        put("menu.nothing", "rien pour l'instant", "nothing yet");
        put("menu.speech", "A dit : « {0} »", "Said: \"{0}\"");
        put("menu.intent", "Décision : {0}", "Decision: {0}");
        put("menu.action", "En cours : {0}", "Running: {0}");
        put("menu.task", "Tâche : {0}", "Task: {0}");
        put("menu.result", "Dernier résultat : {0}", "Last result: {0}");
        put("menu.players", "Joueurs proches : {0}", "Players nearby: {0}");

        put("prompt.tell", "Écris ton conseil pour {0} dans le chat (ou « annuler »). Il le pèsera, il ne l'exécutera pas aveuglément.", "Type your advice for {0} in chat (or \"cancel\"). It will weigh it, not obey it blindly.");
        put("prompt.goal", "Écris le but à proposer à {0} dans le chat (ou « annuler »).", "Type the goal to suggest to {0} in chat (or \"cancel\").");
        put("prompt.cancelled", "Annulé.", "Cancelled.");
        put("prompt.expired", "Plus rien n'est attendu dans le chat.", "Nothing is awaited in chat anymore.");
        put("prompt.cancel_word", "annuler", "cancel");
        put("prompt.cooldown", "Doucement : attends encore {0} s avant de lui reparler.", "Easy: wait {0} s before talking to it again.");

        put("cmd.told", "Conseil transmis à {0} : il y pensera à sa prochaine réflexion.", "Advice delivered to {0}: it will think about it next.");
        put("cmd.goal_set", "But proposé à {0} : « {1} ».", "Goal suggested to {0}: \"{1}\".");
        put("cmd.said", "{0} l'a dit dans le chat.", "{0} said it in chat.");
        put("cmd.failed", "L'esprit n'a pas pu recevoir ça ({0}).", "The mind could not take that ({0}).");
        put("cmd.players_only", "Cette commande s'utilise en jeu.", "This command is for players in game.");
        put("cmd.no_permission", "Tu n'as pas la permission ({0}).", "You lack the permission ({0}).");
        put("cmd.usage", "Usage : /emeth [menu|status|hud|tell|goal|goals|journal|monitor|say|reload]", "Usage: /emeth [menu|status|hud|tell|goal|goals|journal|monitor|say|reload]");
        put("cmd.reloaded", "Configuration rechargée, reconnexion à l'esprit.", "Configuration reloaded, reconnecting to the mind.");
        put("cmd.monitor_given", "Moniteur remis : pose la carte dans un cadre.", "Monitor given: put the map in an item frame.");
        put("cmd.wall_given", "Mur rétine 2×1 remis : gauche puis droite, dans deux cadres côte à côte.", "2×1 retina wall given: left then right, in two adjacent item frames.");
        put("cmd.inventory_full", "Inventaire plein.", "Inventory full.");
        put("cmd.too_long", "Trop long (max {0} caractères).", "Too long (max {0} characters).");

        put("book.goals", "Objectifs de {0}", "{0}'s goals");
        put("book.journal", "Journal de {0}", "{0}'s journal");
        put("book.author", "{0}", "{0}");

        put("announce.stuck", "{0} tourne en rond : {1}", "{0} is going in circles: {1}");
        put("announce.stuck.action", "[Le conseiller]", "[Advise it]");
        put("announce.stuck.hover", "Lui souffler une autre approche", "Whisper another approach");
        put("announce.online", "{0} est réveillé (esprit en ligne).", "{0} is awake (mind online).");
        put("announce.offline", "L'esprit de {0} ne répond plus : son corps reste sur ses réflexes.", "{0}'s mind stopped answering: its body is on reflexes.");

        put("monitor.title", "EMETH - RETINE", "EMETH - RETINA");
        put("monitor.wait", "en attente d'image", "waiting for a frame");
    }

    private static void put(String key, String fr, String en) {
        FR.put(key, fr);
        EN.put(key, en);
    }

    private final Map<String, String> table;

    private Lang(Map<String, String> table) {
        this.table = table;
    }

    public static Lang of(String language) {
        return new Lang("en".equalsIgnoreCase(language) ? EN : FR);
    }

    /** The string for {@code key} with {0}, {1}… replaced; the key itself when unknown (visible, never a crash). */
    public String t(String key, Object... args) {
        String s = table.getOrDefault(key, key);
        for (int i = 0; i < args.length; i++) s = s.replace("{" + i + "}", String.valueOf(args[i]));
        return s;
    }

    public boolean has(String key) {
        return table.containsKey(key);
    }
}
