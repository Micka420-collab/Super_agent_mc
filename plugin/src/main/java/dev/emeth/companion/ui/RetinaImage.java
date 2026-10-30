package dev.emeth.companion.ui;

import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.util.Base64;
import javax.imageio.ImageIO;
import org.bukkit.map.MapFont;
import org.bukkit.map.MinecraftFont;

/**
 * Turns the body's retina (a PNG from the control channel's {@code render}) into 128×128 map tiles. Nearest-neighbour
 * scaling keeps the blocky look honest; the picture is centred between a header and a footer band the map renderer
 * writes text into. No fonts, no AWT drawing beyond pixel copies: safe on headless servers.
 */
public final class RetinaImage {
    public static final int TILE = 128;
    public static final int BAND = 12;
    /** Background of the bands and letterbox: near-black slate. */
    public static final int BACKGROUND = 0xFF14181E;

    private RetinaImage() {}

    /** Decode base64 PNG; null when the payload is empty or not an image (a mind without a retina, a fake body). */
    public static BufferedImage decode(String base64) {
        if (base64 == null || base64.isBlank()) return null;
        try {
            byte[] bytes = Base64.getDecoder().decode(base64);
            return ImageIO.read(new ByteArrayInputStream(bytes));
        } catch (IllegalArgumentException | IOException e) {
            return null;
        }
    }

    /** The render size to ask the body for, so the picture fills the area between the bands without rescaling. */
    public static int[] requestSize(int tiles) {
        return new int[] {TILE * tiles, TILE - 2 * BAND};
    }

    /** Compose the full monitor (tiles×128 wide, 128 high): bands top and bottom, the retina fitted in between. */
    public static BufferedImage compose(BufferedImage retina, int tiles) {
        int w = TILE * tiles;
        BufferedImage out = new BufferedImage(w, TILE, BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < TILE; y++) for (int x = 0; x < w; x++) out.setRGB(x, y, BACKGROUND);
        if (retina == null) return out;
        int areaW = w;
        int areaH = TILE - 2 * BAND;
        double scale = Math.min(areaW / (double) retina.getWidth(), areaH / (double) retina.getHeight());
        int dw = Math.max(1, (int) Math.floor(retina.getWidth() * scale));
        int dh = Math.max(1, (int) Math.floor(retina.getHeight() * scale));
        int ox = (areaW - dw) / 2;
        int oy = BAND + (areaH - dh) / 2;
        for (int y = 0; y < dh; y++) {
            int sy = Math.min(retina.getHeight() - 1, (int) (y / scale));
            for (int x = 0; x < dw; x++) {
                int sx = Math.min(retina.getWidth() - 1, (int) (x / scale));
                out.setRGB(ox + x, oy + y, 0xFF000000 | retina.getRGB(sx, sy));
            }
        }
        return out;
    }

    /** Cut a composed monitor into its 128×128 map tiles, left to right. */
    public static BufferedImage[] split(BufferedImage composed) {
        int tiles = Math.max(1, composed.getWidth() / TILE);
        BufferedImage[] out = new BufferedImage[tiles];
        for (int i = 0; i < tiles; i++) {
            BufferedImage tile = new BufferedImage(TILE, TILE, BufferedImage.TYPE_INT_ARGB);
            for (int y = 0; y < TILE; y++) for (int x = 0; x < TILE; x++) tile.setRGB(x, y, composed.getRGB(i * TILE + x, y));
            out[i] = tile;
        }
        return out;
    }

    /** A copy of {@code tile} with a header and a footer written in the Minecraft map font (exact colours, ASCII only). */
    public static BufferedImage caption(BufferedImage tile, String header, String footer, int headerRgb, int footerRgb) {
        BufferedImage out = new BufferedImage(tile.getWidth(), tile.getHeight(), BufferedImage.TYPE_INT_ARGB);
        for (int y = 0; y < tile.getHeight(); y++) for (int x = 0; x < tile.getWidth(); x++) out.setRGB(x, y, tile.getRGB(x, y));
        drawText(out, 3, 2, fit(Text.ascii(header), tile.getWidth() - 6), headerRgb);
        drawText(out, 3, tile.getHeight() - BAND + 2, fit(Text.ascii(footer), tile.getWidth() - 6), footerRgb);
        return out;
    }

    /** Paint {@code text} glyph by glyph from {@link MinecraftFont}; unknown characters are skipped. Returns the end x. */
    public static int drawText(BufferedImage img, int x, int y, String text, int rgb) {
        int cx = x;
        for (char c : text.toCharArray()) {
            MapFont.CharacterSprite sprite = MinecraftFont.Font.getChar(c);
            if (sprite == null) continue;
            for (int row = 0; row < sprite.getHeight(); row++) {
                for (int col = 0; col < sprite.getWidth(); col++) {
                    int px = cx + col;
                    int py = y + row;
                    if (sprite.get(row, col) && px >= 0 && py >= 0 && px < img.getWidth() && py < img.getHeight()) img.setRGB(px, py, 0xFF000000 | rgb);
                }
            }
            cx += sprite.getWidth() + 1;
        }
        return cx;
    }

    /** The longest prefix of {@code s} the map font draws within {@code px} pixels. */
    public static String fit(String s, int px) {
        StringBuilder out = new StringBuilder();
        int width = 0;
        for (char c : s.toCharArray()) {
            MapFont.CharacterSprite sprite = MinecraftFont.Font.getChar(c);
            if (sprite == null) continue;
            int w = sprite.getWidth() + 1;
            if (width + w > px) break;
            out.append(c);
            width += w;
        }
        return out.toString();
    }
}
