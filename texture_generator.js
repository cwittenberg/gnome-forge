// texture_generator.js
import cairo from 'gi://cairo';
import GLib from 'gi://GLib';

export class TextureGenerator {
    static hexToRgba(hex) {
        if (!hex) return [0, 0, 0, 0];
        let c = hex.replace('#', '');
        if (c.length === 3) c = c.split('').map(x => x + x).join('');
        if (c.length === 6) c += 'FF';
        if (c.length !== 8) return [0, 0, 0, 1];
        let r = parseInt(c.substring(0, 2), 16) / 255;
        let g = parseInt(c.substring(2, 4), 16) / 255;
        let b = parseInt(c.substring(4, 6), 16) / 255;
        let a = parseInt(c.substring(6, 8), 16) / 255;
        return [r, g, b, a];
    }

    static render(recipeJson, outputPath) {
        try {
            let recipe = JSON.parse(recipeJson);
            let w = recipe.width || 64;
            let h = recipe.height || 64;
            let surface = new cairo.ImageSurface(cairo.Format.ARGB32, w, h);
            let cr = new cairo.Context(surface);

            let dir = GLib.path_get_dirname(outputPath);
            GLib.mkdir_with_parents(dir, 0o755);

            cr.setOperator(cairo.Operator.SOURCE);
            
            if (recipe.background) {
                let bg = this.hexToRgba(recipe.background);
                cr.setSourceRGBA(bg[0], bg[1], bg[2], bg[3]);
                cr.paint();
            } else {
                cr.setSourceRGBA(0, 0, 0, 0);
                cr.paint();
            }

            cr.setOperator(cairo.Operator.OVER);

            if (recipe.type === 'pixel_art') {
                let sw = w / recipe.pixels[0].length;
                let sh = h / recipe.pixels.length;
                for (let y = 0; y < recipe.pixels.length; y++) {
                    let row = recipe.pixels[y];
                    for (let x = 0; x < row.length; x++) {
                        let char = row[x];
                        let hex = recipe.palette[char];
                        if (hex) {
                            let color = this.hexToRgba(hex);
                            cr.setSourceRGBA(color[0], color[1], color[2], color[3]);
                            cr.rectangle(x * sw, y * sh, sw, sh);
                            cr.fill();
                        }
                    }
                }
            } 
            else if (recipe.type === 'gradient') {
                let pat = new cairo.LinearGradient(0, 0, recipe.direction === 'horizontal' ? w : 0, recipe.direction === 'horizontal' ? 0 : h);
                if (recipe.stops) {
                    recipe.stops.forEach(stop => {
                        let c = this.hexToRgba(stop.color);
                        pat.addColorStopRGBA(stop.offset, c[0], c[1], c[2], c[3]);
                    });
                }
                cr.setSource(pat);
                cr.rectangle(0, 0, w, h);
                cr.fill();
            }
            else if (recipe.type === 'shapes') {
                if (recipe.shapes) {
                    for (let shape of recipe.shapes) {
                        let c = this.hexToRgba(shape.color);
                        cr.setSourceRGBA(c[0], c[1], c[2], c[3]);
                        if (shape.type === 'rect') {
                            cr.rectangle(shape.x, shape.y, shape.w, shape.h);
                            cr.fill();
                        } else if (shape.type === 'circle') {
                            cr.arc(shape.cx, shape.cy, shape.r, 0, 2 * Math.PI);
                            cr.fill();
                        }
                    }
                }
            }

            if (recipe.noise && recipe.noise > 0) {
                for (let y = 0; y < h; y++) {
                    for (let x = 0; x < w; x++) {
                        let n = (Math.random() - 0.5) * recipe.noise;
                        cr.setSourceRGBA(n > 0 ? 1 : 0, n > 0 ? 1 : 0, n > 0 ? 1 : 0, Math.abs(n));
                        cr.rectangle(x, y, 1, 1);
                        cr.fill();
                    }
                }
            }

            surface.writeToPNG(outputPath);
            return `SUCCESS: Texture saved to ${outputPath}`;
        } catch (e) {
            return `FAILURE: Texture rendering failed: ${e.message}`;
        }
    }
}