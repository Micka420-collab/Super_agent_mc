package dev.emeth.companion.mind;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import java.util.ArrayList;
import java.util.List;

/** One line of the agent's episodic timeline, as returned by the control channel's {@code timeline} method. */
public record TimelineEntry(double ts, String kind, String text, int count, List<String> actors) {

    public String key() {
        return ts + "|" + kind + "|" + text;
    }

    public static List<TimelineEntry> parseAll(JsonElement timeline) {
        List<TimelineEntry> out = new ArrayList<>();
        if (timeline == null || !timeline.isJsonArray()) return out;
        JsonArray arr = timeline.getAsJsonArray();
        for (JsonElement e : arr) {
            if (e == null || !e.isJsonObject()) continue;
            out.add(new TimelineEntry(Json.num(e, "ts", 0), Json.str(e, "kind", "note"), Json.str(e, "text", ""), (int) Json.num(e, "count", 1), Json.strings(e, "actors")));
        }
        return out;
    }
}
