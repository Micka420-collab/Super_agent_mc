package dev.emeth.companion.mind;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Tolerant reads over Gson trees: a mind newer or older than the plugin must never crash the server. */
public final class Json {
    private Json() {}

    /** Walk a dotted path ("self.position.x"); null when any step is missing or not an object. */
    public static JsonElement at(JsonElement root, String path) {
        JsonElement cur = root;
        for (String part : path.split("\\.")) {
            if (cur == null || !cur.isJsonObject()) return null;
            cur = cur.getAsJsonObject().get(part);
        }
        return cur == null || cur.isJsonNull() ? null : cur;
    }

    public static String str(JsonElement root, String path, String fallback) {
        JsonElement e = at(root, path);
        if (e == null || !e.isJsonPrimitive()) return fallback;
        return e.getAsString();
    }

    public static double num(JsonElement root, String path, double fallback) {
        JsonElement e = at(root, path);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) return fallback;
        return e.getAsDouble();
    }

    public static boolean bool(JsonElement root, String path, boolean fallback) {
        JsonElement e = at(root, path);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isBoolean()) return fallback;
        return e.getAsBoolean();
    }

    public static JsonObject obj(JsonElement root, String path) {
        JsonElement e = at(root, path);
        return e != null && e.isJsonObject() ? e.getAsJsonObject() : null;
    }

    public static List<String> strings(JsonElement root, String path) {
        JsonElement e = at(root, path);
        List<String> out = new ArrayList<>();
        if (e == null || !e.isJsonArray()) return out;
        for (JsonElement item : e.getAsJsonArray()) {
            if (item != null && item.isJsonPrimitive()) out.add(item.getAsString());
        }
        return out;
    }

    public static JsonArray arr(JsonElement root, String path) {
        JsonElement e = at(root, path);
        return e != null && e.isJsonArray() ? e.getAsJsonArray() : new JsonArray();
    }

    /** Numeric members of an object, in order (drives). */
    public static Map<String, Double> numbers(JsonElement root, String path) {
        Map<String, Double> out = new LinkedHashMap<>();
        JsonObject o = obj(root, path);
        if (o == null) return out;
        for (Map.Entry<String, JsonElement> entry : o.entrySet()) {
            JsonElement v = entry.getValue();
            if (v != null && v.isJsonPrimitive() && v.getAsJsonPrimitive().isNumber()) out.put(entry.getKey(), v.getAsDouble());
        }
        return out;
    }
}
