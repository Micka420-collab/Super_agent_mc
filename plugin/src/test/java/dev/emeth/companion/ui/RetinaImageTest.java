package dev.emeth.companion.ui;

import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import dev.emeth.companion.Fixtures;
import dev.emeth.companion.mind.Json;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.util.Base64;
import javax.imageio.ImageIO;
import org.junit.jupiter.api.Test;

class RetinaImageTest {

    private static String png(int w, int h, int rgb) throws Exception {
        BufferedImage img = new BufferedImage(w, h, BufferedImage.TYPE_INT_RGB);
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) img.setRGB(x, y, x < w / 2 ? rgb : 0x00FF00);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(img, "png", out);
        return Base64.getEncoder().encodeToString(out.toByteArray());
    }

    @Test
    void asksTheBodyForExactlyTheAreaBetweenTheBands() {
        assertArrayEquals(new int[] {128, 104}, RetinaImage.requestSize(1));
        assertArrayEquals(new int[] {256, 104}, RetinaImage.requestSize(2));
    }

    @Test
    void decodesRealPngsAndRefusesGarbage() throws Exception {
        assertNotNull(RetinaImage.decode(png(8, 4, 0xFF0000)));
        assertNull(RetinaImage.decode(""));
        assertNull(RetinaImage.decode("%%%"));
        // the fake body's retina in the fixture is only a PNG signature: not an image, handled
        assertNull(RetinaImage.decode(Json.str(Fixtures.load("render.json"), "pngBase64", null)));
    }

    @Test
    void composesBandsAndFitsWithoutDistortion() throws Exception {
        BufferedImage retina = RetinaImage.decode(png(128, 104, 0xFF0000));
        BufferedImage mon = RetinaImage.compose(retina, 1);
        assertEquals(128, mon.getWidth());
        assertEquals(128, mon.getHeight());
        assertEquals(RetinaImage.BACKGROUND, mon.getRGB(5, 3), "header band");
        assertEquals(RetinaImage.BACKGROUND, mon.getRGB(5, 125), "footer band");
        assertEquals(0xFFFF0000, mon.getRGB(10, 60), "left half red");
        assertEquals(0xFF00FF00, mon.getRGB(120, 60), "right half green");

        // a 16:9 retina in a 2×1 wall is letterboxed, never stretched
        BufferedImage wide = RetinaImage.decode(png(96, 54, 0xFF0000));
        BufferedImage wall = RetinaImage.compose(wide, 2);
        assertEquals(256, wall.getWidth());
        BufferedImage[] tiles = RetinaImage.split(wall);
        assertEquals(2, tiles.length);
        assertEquals(RetinaImage.BACKGROUND, tiles[0].getRGB(2, 64), "pillarbox on the left");
        assertEquals(0xFFFF0000, tiles[0].getRGB(100, 64));
        assertEquals(0xFF00FF00, tiles[1].getRGB(30, 64));
        assertEquals(RetinaImage.BACKGROUND, RetinaImage.compose(null, 1).getRGB(64, 64), "no frame yet: blank screen");
    }

    @Test
    void writesCaptionsWithTheMapFont() {
        BufferedImage blank = RetinaImage.compose(null, 1);
        BufferedImage captioned = RetinaImage.caption(blank, "EMETH - RETINE", "descend", 0xE0B04B, 0xE8E3D8);
        int gold = 0;
        int ink = 0;
        for (int y = 0; y < 128; y++) {
            for (int x = 0; x < 128; x++) {
                if (captioned.getRGB(x, y) == 0xFFE0B04B) {
                    gold++;
                    assertTrue(y < RetinaImage.BAND, "header stays in its band");
                }
                if (captioned.getRGB(x, y) == 0xFFE8E3D8) {
                    ink++;
                    assertTrue(y >= 128 - RetinaImage.BAND, "footer stays in its band");
                }
            }
        }
        assertTrue(gold > 30 && ink > 15, "glyph pixels were painted: " + gold + "/" + ink);
        assertEquals(RetinaImage.BACKGROUND, blank.getRGB(4, 4), "the source tile is untouched");
        assertNotEquals("", RetinaImage.fit("A very long caption that will not fit on a map", 122));
        assertTrue(RetinaImage.fit("A very long caption that will not fit on a map", 122).length() < 46);
    }
}
