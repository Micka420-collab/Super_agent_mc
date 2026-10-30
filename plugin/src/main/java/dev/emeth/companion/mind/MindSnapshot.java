package dev.emeth.companion.mind;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.List;
import java.util.Map;

/**
 * One reading of the mind's {@code status} method — everything the in-game interface shows. Parsed tolerantly: a
 * missing block yields neutral values, never an exception (the shape is pinned by protocol/fixtures/control/status.json).
 */
public record MindSnapshot(
        String name,
        String stage,
        int level,
        double experience,
        boolean bodyConnected,
        String username,
        Vitals vitals,
        Map<String, Double> drives,
        Goals goals,
        String task,
        String action,
        Thought thought,
        String lastResult,
        Threat threat,
        Reflection reflection,
        List<String> nearbyPlayers,
        int nearbyHostiles,
        boolean languageMindAvailable,
        long decisions) {

    /** Body state as last observed; {@code null} until the body has sent an observation. */
    public record Vitals(double health, double food, int xpLevel, int day, String phase, String dimension, String biome, String held, double x, double y, double z) {}

    public record Goals(List<String> done, int total, String next, List<String> active) {
        public double progress() {
            return total <= 0 ? 0 : Math.min(1.0, done.size() / (double) total);
        }
    }

    public record Thought(String reason, String intent, String speech, double at) {
        public boolean isEmpty() {
            return reason.isBlank() && intent.isBlank();
        }
    }

    public record Threat(double danger, String recommendation, List<String> reasons, int count, String nearestName, double nearestDistance) {
        public static final Threat CALM = new Threat(0, "calm", List.of(), 0, null, 0);
    }

    public record Reflection(boolean stuck, double failureRate, int invalidDecisions, String sameFailure, String codeStreak) {}

    public double drive(String key) {
        Double v = drives.get(key);
        return v == null ? 0 : v;
    }

    public double mood() {
        return drives.containsKey("mood") ? drive("mood") : 0.6;
    }

    public static MindSnapshot parse(JsonElement status) {
        JsonObject self = Json.obj(status, "self");
        Vitals vitals = null;
        if (self != null) {
            vitals = new Vitals(
                    Json.num(self, "health", 20), Json.num(self, "food", 20), (int) Json.num(self, "xpLevel", 0), (int) Json.num(self, "day", 0),
                    Json.str(self, "phase", "day"), Json.str(self, "dimension", "overworld"), Json.str(self, "biome", ""), Json.str(self, "held", null),
                    Json.num(self, "position.x", 0), Json.num(self, "position.y", 0), Json.num(self, "position.z", 0));
        }
        Goals goals = new Goals(Json.strings(status, "goals.done"), (int) Json.num(status, "goals.total", 0), Json.str(status, "goals.next", null), Json.strings(status, "goals.goals"));
        Thought thought = new Thought(Json.str(status, "thought.reason", ""), Json.str(status, "thought.intent", ""), Json.str(status, "thought.speech", ""), Json.num(status, "thought.at", 0));
        Threat threat = Threat.CALM;
        JsonObject t = Json.obj(status, "threat");
        if (t != null) {
            threat = new Threat(Json.num(t, "danger", 0), Json.str(t, "recommendation", "calm"), Json.strings(t, "reasons"), (int) Json.num(t, "count", 0),
                    Json.str(t, "nearest.name", null), Json.num(t, "nearest.distance", 0));
        }
        Reflection reflection = null;
        JsonObject r = Json.obj(status, "reflection");
        if (r != null) {
            reflection = new Reflection(Json.bool(r, "stuck", false), Json.num(r, "failure_rate", 0), (int) Json.num(r, "invalid_decisions", 0),
                    describeStreak(Json.arr(r, "same_failure")), describeStreak(Json.arr(r, "code_streak")));
        }
        boolean llm = false;
        JsonObject router = Json.obj(status, "router");
        if (router != null) {
            for (Map.Entry<String, JsonElement> e : router.entrySet()) {
                if (Json.bool(e.getValue(), "available", false)) llm = true;
            }
        }
        String username = Json.str(status, "body.username", null);
        if (username == null) username = Json.str(status, "body.minecraft.username", null);
        return new MindSnapshot(
                Json.str(status, "name", "Emeth"),
                Json.str(status, "autonomy.stage", "newborn"),
                (int) Json.num(status, "autonomy.level", 0),
                Json.num(status, "autonomy.experience", 0),
                Json.bool(status, "body.connected", false),
                username,
                vitals,
                Json.numbers(status, "drives"),
                goals,
                Json.str(status, "task", null),
                Json.str(status, "action", null),
                thought,
                Json.str(status, "last_result", ""),
                threat,
                reflection,
                Json.strings(status, "nearby.players"),
                (int) Json.num(status, "nearby.hostiles", 0),
                llm,
                (long) Json.num(status, "stats.decisions", 0));
    }

    /** ["mine({...})", "NOT_FOUND", 2] → "mine({...}) ×2 (NOT_FOUND)"; ["NO_PATH", 3] → "NO_PATH ×3". */
    static String describeStreak(com.google.gson.JsonArray a) {
        if (a == null || a.isEmpty()) return null;
        if (a.size() >= 3) return a.get(0).getAsString() + " ×" + a.get(2).getAsString() + " (" + a.get(1).getAsString() + ")";
        if (a.size() == 2) return a.get(0).getAsString() + " ×" + a.get(1).getAsString();
        return a.get(0).getAsString();
    }
}
