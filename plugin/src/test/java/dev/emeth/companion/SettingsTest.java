package dev.emeth.companion;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.bukkit.configuration.file.YamlConfiguration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class SettingsTest {

    private static YamlConfiguration defaults() {
        return YamlConfiguration.loadConfiguration(new InputStreamReader(Objects.requireNonNull(SettingsTest.class.getResourceAsStream("/config.yml")), StandardCharsets.UTF_8));
    }

    @Test
    void shippedDefaultsReadTheTokenFileNextToTheMind(@TempDir Path root) throws Exception {
        // layout of the repository: <root>/server (the Minecraft server's directory) next to <root>/mind
        Path server = Files.createDirectories(root.resolve("server"));
        Path mindData = root.resolve("mind/data");
        Files.createDirectories(mindData);
        Files.writeString(mindData.resolve("control.token"), "tok-123\n");
        Settings s = Settings.from(defaults(), server, Map.of());
        assertEquals("ws://127.0.0.1:8766", s.mindUrl().toString());
        assertEquals("tok-123", s.token());
        assertEquals(2, s.pollSeconds());
        assertEquals("fr", s.language());
        assertTrue(s.hologram());
        assertFalse(s.hudOnJoin());
        assertEquals(Set.of("achievement", "death"), s.announceKinds());
        assertFalse(s.announceToAll());
        assertTrue(s.warnings().isEmpty(), s.warnings().toString());
    }

    @Test
    void tokenPrecedenceIsConfigThenEnvironmentThenFile(@TempDir Path root) throws Exception {
        Path server = Files.createDirectories(root.resolve("server"));
        YamlConfiguration c = defaults();
        Settings fromEnv = Settings.from(c, server, Map.of(Settings.TOKEN_ENV, " env-tok "));
        assertEquals("env-tok", fromEnv.token());
        assertEquals(Settings.TOKEN_ENV, fromEnv.tokenSource());
        c.set("mind.token", "cfg-tok");
        assertEquals("cfg-tok", Settings.from(c, server, Map.of(Settings.TOKEN_ENV, "env-tok")).token());
        YamlConfiguration none = defaults();
        Settings missing = Settings.from(none, server, Map.of());
        assertEquals("", missing.token());
        assertTrue(missing.warnings().getFirst().contains("no control token"));
    }

    @Test
    void refusesARemoteMindUnlessDeliberatelyAllowed(@TempDir Path root) throws Exception {
        Path server = Files.createDirectories(root.resolve("server"));
        YamlConfiguration c = defaults();
        c.set("mind.url", "ws://203.0.113.7:8766");
        IllegalArgumentException e = assertThrows(IllegalArgumentException.class, () -> Settings.from(c, server, Map.of()));
        assertTrue(e.getMessage().contains("allow-remote"));
        c.set("mind.allow-remote", true);
        Settings s = Settings.from(c, server, Map.of());
        assertTrue(s.warnings().stream().anyMatch(w -> w.contains("not encrypted")));
        c.set("mind.url", "wss://mind.example.org/emeth");
        assertTrue(Settings.from(c, server, Map.of()).warnings().stream().noneMatch(w -> w.contains("not encrypted")));
        c.set("mind.url", "http://127.0.0.1:8766");
        assertThrows(IllegalArgumentException.class, () -> Settings.from(c, server, Map.of()));
    }

    @Test
    void clampsNumbersAndHonoursAudience(@TempDir Path root) throws Exception {
        Path server = Files.createDirectories(root.resolve("server"));
        YamlConfiguration c = defaults();
        c.set("mind.poll-seconds", 0);
        c.set("mentor.max-length", 99999);
        c.set("announce.audience", "all");
        c.set("announce.kinds", java.util.List.of("Achievement", "failure"));
        Settings s = Settings.from(c, server, Map.of());
        assertEquals(1, s.pollSeconds());
        assertEquals(1200, s.mentorMaxLength());
        assertTrue(s.announceToAll());
        assertEquals(Set.of("achievement", "failure"), s.announceKinds());
    }
}
