package dev.emeth.companion;

import java.io.IOException;
import java.net.URI;
import java.net.URISyntaxException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import dev.emeth.companion.mind.MindClient;
import org.bukkit.configuration.ConfigurationSection;

/** The plugin's configuration, validated once. Pure: the server directory and the environment are passed in. */
public record Settings(
        URI mindUrl,
        String token,
        String tokenSource,
        int pollSeconds,
        int timeoutSeconds,
        String botUsername,
        String language,
        boolean hologram,
        int thoughtSeconds,
        float hologramHeight,
        boolean hudOnJoin,
        boolean sidebar,
        boolean bossbar,
        boolean actionbar,
        int monitorRefreshSeconds,
        Set<String> announceKinds,
        boolean announceToAll,
        boolean stuckAlert,
        int mentorCooldownSeconds,
        int mentorMaxLength,
        List<String> warnings) {

    public static final String TOKEN_ENV = "EMETH_CONTROL_TOKEN";

    public static Settings from(ConfigurationSection c, Path serverDir, Map<String, String> env) {
        List<String> warnings = new ArrayList<>();
        URI url;
        try {
            url = new URI(c.getString("mind.url", "ws://127.0.0.1:8766").strip());
        } catch (URISyntaxException e) {
            throw new IllegalArgumentException("mind.url is not a valid URL: " + e.getMessage());
        }
        String scheme = url.getScheme() == null ? "" : url.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("ws") && !scheme.equals("wss")) throw new IllegalArgumentException("mind.url must start with ws:// or wss:// (got " + url + ")");
        boolean local = MindClient.isLocal(url);
        if (!local && !c.getBoolean("mind.allow-remote", false)) {
            throw new IllegalArgumentException("mind.url points outside this machine (" + url.getHost() + "): the control channel carries a token and "
                    + "can make the agent speak; set mind.allow-remote: true deliberately (and prefer wss:// behind a TLS proxy)");
        }
        if (!local && scheme.equals("ws")) warnings.add("the control channel to " + url.getHost() + " is not encrypted (ws://): use wss:// behind a TLS proxy");

        String token = c.getString("mind.token", "").strip();
        String source = "mind.token";
        if (token.isEmpty() && env.get(TOKEN_ENV) != null && !env.get(TOKEN_ENV).isBlank()) {
            token = env.get(TOKEN_ENV).strip();
            source = TOKEN_ENV;
        }
        if (token.isEmpty()) {
            String file = c.getString("mind.token-file", "../mind/data/control.token");
            Path path = serverDir.resolve(file).normalize();
            source = path.toString();
            try {
                token = Files.readString(path, StandardCharsets.UTF_8).strip();
            } catch (IOException e) {
                warnings.add("no control token: mind.token is empty, " + TOKEN_ENV + " is unset and " + path + " cannot be read (" + e.getClass().getSimpleName() + ")");
            }
        }

        Set<String> kinds = new LinkedHashSet<>();
        for (String k : c.getStringList("announce.kinds")) kinds.add(k.strip().toLowerCase(Locale.ROOT));
        if (!c.isSet("announce.kinds")) kinds.addAll(List.of("achievement", "death"));

        return new Settings(
                url,
                token,
                source,
                clamp(c.getInt("mind.poll-seconds", 2), 1, 60),
                clamp(c.getInt("mind.timeout-seconds", 10), 2, 120),
                c.getString("bot.username", "").strip(),
                c.getString("language", "fr").strip(),
                c.getBoolean("hologram.enabled", true),
                clamp(c.getInt("hologram.thought-seconds", 12), 0, 120),
                (float) Math.max(0, Math.min(3, c.getDouble("hologram.height", 0.45))),
                c.getBoolean("hud.default-on-join", false),
                c.getBoolean("hud.sidebar", true),
                c.getBoolean("hud.bossbar", true),
                c.getBoolean("hud.actionbar", true),
                clamp(c.getInt("monitor.refresh-seconds", 3), 1, 60),
                Set.copyOf(kinds),
                "all".equalsIgnoreCase(c.getString("announce.audience", "followers")),
                c.getBoolean("announce.stuck-alert", true),
                clamp(c.getInt("mentor.cooldown-seconds", 5), 0, 600),
                clamp(c.getInt("mentor.max-length", 600), 20, 1200),
                List.copyOf(warnings));
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
