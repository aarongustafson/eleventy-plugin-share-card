# eleventy-plugin-share-card

Build-time social share-card (OG image) generator for [Eleventy](https://www.11ty.dev/). No external services required — images are composited locally at build time using [sharp](https://sharp.pixelplumbing.com/) and cached on disk so unchanged posts are never re-processed.

## Features

- 🖼 Composites any number of text layers onto a base template image
- 🔤 Embeds custom fonts (WOFF2 / TTF / OTF) directly into the SVG — no system font installation needed
- 💾 Disk cache keyed by content hash — only regenerates when text changes
- 🧩 Works as an **Eleventy plugin** (registers a `shareCard` filter) **or** as a standalone **generator factory** for use inside `eleventyComputed` data files
- 🚫 Zero calls to Cloudinary, imgix, or any other external image API

## Installation

```bash
npm install eleventy-plugin-share-card sharp proper-lockfile
```

> `sharp` and `proper-lockfile` are peer dependencies. If your project already has them, you're all set.

### Optional: fonts via fontsource

The plugin accepts any local font file — you can source them however you like. [Fontsource](https://fontsource.org/) is an easy option:

```bash
npm install @fontsource/source-serif-4 @fontsource/open-sans
```

---

## Quick start

### Option A — Eleventy plugin (adds a `shareCard` filter)

```js
// .eleventy.js
import shareCardPlugin from "eleventy-plugin-share-card";

export default (eleventyConfig) => {
  eleventyConfig.addPlugin(shareCardPlugin, {
    baseImagePath: "./src/_images/share-card.jpg",
    outputDir:     "./src/static/i/share-cards",
    outputUrlPath: "/i/share-cards",
    cacheFile:     "./_cache/share-cards.json",
    verbose:       true,
    imageWidth:    1280,
    imageHeight:   669,
    layers: [
      {
        font:        "Source Serif 4",
        fontPath:    "node_modules/@fontsource/source-serif-4/files/source-serif-4-latin-700-normal.woff2",
        fontSize:    72,
        fontWeight:  700,
        color:       "#2C2825",
        x:           480,
        y:           { from: "bottom", value: 205 },
        maxWidth:    760,
        lineSpacing: -18,
      },
      {
        font:        "Open Sans",
        fontPath:    "node_modules/@fontsource/open-sans/files/open-sans-latin-300-normal.woff2",
        fontSize:    36,
        fontWeight:  300,
        color:       "#505050",
        x:           480,
        y:           { from: "top", value: 505 },
        maxWidth:    760,
        lineSpacing: -5,
      },
    ],
  });
};
```

### Option B — Generator factory in an `eleventyComputed` data file

This is the recommended pattern for data files because it gives you full control over which text goes into each layer.

Pass `eleventyConfig` as the second argument to `createGenerator` to enable
**deferred generation**: every call is queued (most-recent data wins per slug)
and images are generated once in a single `eleventy.after` pass at the end of
the build.  This prevents the redundant double-generation that occurs because
Eleventy re-evaluates `eleventyComputed` properties on every collection access
— sometimes with incomplete data on the first pass.

The cleanest way to use this pattern is to create the generator inside the
Eleventy config and register it as a JavaScript function so data files can
access it:

```js
// .eleventy.js
import { createGenerator } from "eleventy-plugin-share-card";

export default (eleventyConfig) => {
  const generateShareCard = createGenerator(
    {
      baseImagePath: "./src/_images/share-card.jpg",
      outputDir:     "./src/static/i/share-cards",
      outputUrlPath: "/i/share-cards",
      verbose:       true,
      layers: [
        { font: "Source Serif 4", fontPath: "...", fontSize: 72, fontWeight: 700,
          color: "#2C2825", x: 480, y: { from: "bottom", value: 205 }, maxWidth: 760, lineSpacing: -18 },
        { font: "Open Sans",      fontPath: "...", fontSize: 36, fontWeight: 300,
          color: "#505050", x: 480, y: { from: "top",    value: 505 }, maxWidth: 760, lineSpacing: -5  },
      ],
    },
    eleventyConfig,    // ← enables deferred mode + eleventy.after hook
  );

  // Expose the generator as a callable JavaScript template function so that
  // eleventyComputed data files can invoke it via `this.generateShareCard(…)`.
  // See https://www.11ty.dev/docs/languages/javascript/#javascript-template-functions
  eleventyConfig.addJavaScriptFunction("generateShareCard", generateShareCard);
};
```

```js
// src/posts/posts.11tydata.js
export default {
  eleventyComputed: {
    image: async function (data) {
      if (data.hero) return `${data.site.url}${data.hero.src}`;
      // `this.generateShareCard` is the function registered above
      return this.generateShareCard(
        [data.title, myTagsToHashtags(data.tags)],
        data.page.fileSlug,
      );
    },
  },
};
```

If you prefer to call `createGenerator` directly from a data file (without
access to `eleventyConfig`), the generator falls back to **immediate mode**
and behaviour is identical to previous versions — each call generates on the
spot with the in-memory build cache preventing duplicate work when the hash is
stable.

```js
// src/posts/posts.11tydata.js  (immediate / legacy mode — no eleventyConfig)
import { createGenerator } from "eleventy-plugin-share-card";

const generateShareCard = createGenerator({
  baseImagePath: "./src/_images/share-card.jpg",
  outputDir:     "./src/static/i/share-cards",
  outputUrlPath: "/i/share-cards",
  verbose:       true,
  layers: [ /* … */ ],
});

export default {
  eleventyComputed: {
    image: async (data) => {
      if (data.hero) return `${data.site.url}${data.hero.src}`;
      return generateShareCard(
        [data.title, myTagsToHashtags(data.tags)],
        data.page.fileSlug,
      );
    },
  },
};
```

---

## Options reference

### `createGenerator(options, eleventyConfig?)`

`options` is the same object as the top-level plugin options above.

`eleventyConfig` is the Eleventy `UserConfig` object (optional).  When
supplied the generator registers an `eleventy.after` listener and switches to
**deferred mode** — see [Quick start Option B](#option-b--generator-factory-in-an-eleventycomputed-data-file) for details.

### Top-level options

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `baseImagePath` | `string` | ✅ | — | Path to the template image (JPEG or PNG). Relative paths are resolved from `process.cwd()`. |
| `outputDir` | `string` | ✅ | — | Directory where generated share-card images are written. Created automatically if missing. |
| `outputUrlPath` | `string` | ✅ | — | URL prefix returned in the generated image path (e.g. `"/i/share-cards"`). |
| `cacheFile` | `string` | | `./_cache/share-cards.json` | Path to the JSON cache file. |
| `buildCache` | `boolean` | | `true` | Build-scoped in-memory memoization keyed by slug. Prevents duplicate generator work when the same item is accessed multiple times during one build. |
| `verbose` | `boolean` | | `false` | Logs cache hits/misses and generation progress to the console. |
| `imageWidth` | `number` | | `1280` | Width of `baseImagePath` in pixels (used for SVG canvas size). |
| `imageHeight` | `number` | | `669` | Height of `baseImagePath` in pixels. |
| `jpegQuality` | `number` | | `90` | Output JPEG quality (1–100). |
| `layers` | `Layer[]` | ✅ | — | Text layer definitions — see below. |

### Layer options

Each entry in `layers` configures one text block composited over the base image.

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `font` | `string` | ✅ | — | CSS `font-family` value (e.g. `"Source Serif 4"`). |
| `fontFallback` | `string` | | `"serif"` | Generic CSS font family used as a fallback when the custom font is unavailable (e.g. `"sans-serif"` for sans-serif faces, `"monospace"` for monospace). |
| `fontPath` | `string` | | — | Path to a WOFF2, WOFF, TTF, or OTF file. When provided the font is embedded as a base64 data URI so the generator works without system fonts. Relative paths are resolved from `process.cwd()`. |
| `fontSize` | `number` | ✅ | — | Font size in pixels. |
| `fontWeight` | `number` | | `400` | CSS font-weight (e.g. `700` for bold, `300` for light). |
| `color` | `string` | | `"#000000"` | Hex color with or without leading `#`. |
| `x` | `number` | ✅ | — | Left edge of the text area in pixels from the left of the image. |
| `y` | `number \| {from, value}` | ✅ | — | Vertical position. A plain number is treated as pixels from the top. Pass `{ from: "bottom", value: N }` to anchor the *bottom* of the text block N pixels from the bottom of the image (like Cloudinary's `south_west` gravity). |
| `maxWidth` | `number` | ✅ | — | Maximum text-area width in pixels. Text is word-wrapped to fit. |
| `lineSpacing` | `number` | | `0` | Adjustment to the default `1.2×` line height in pixels. Negative values tighten lines (same semantic as Cloudinary's `line_spacing` parameter). |

### Generator function signature

```ts
generateShareCard(texts: string[], slug: string): Promise<string>
```

| Argument | Description |
|---|---|
| `texts` | Array of strings, one per configured layer (in the same order). Empty strings skip that layer. |
| `slug` | Unique identifier used as the output filename (e.g. `data.page.fileSlug`). The cache is also keyed by slug. |

**Returns** the public URL path (e.g. `"/i/share-cards/my-post.jpg"`) or `""` on error.

---

## Caching

Generated images are cached in two layers by slug:

1. **Build queue / deferred generation** (deferred mode only, when `eleventyConfig` is
   provided): every `generateShareCard()` call within a build is queued instead of
   executed immediately.  When the same slug is queued multiple times (because Eleventy
   re-evaluates `eleventyComputed` properties for each collection access), only the
   **last** call's data is used — ensuring the image is always generated with the
   most complete data.  The actual image generation happens once per slug in the
   `eleventy.after` event at the end of the build.
2. **Build cache** (immediate mode only): in-memory memoization keyed by slug + content
   hash; returns the same promise for repeated calls with the same data during one build.
3. **File cache** (`cacheFile`): persists across builds and skips generation when the
   hash and output file still match.

On each cache miss the generator:

1. Computes a SHA-256 hash of all text strings for that image.
2. Looks up the slug in `cacheFile`.
3. If the hash matches **and** the output file exists → returns the cached URL immediately (no image processing).
4. Otherwise → generates the image, writes the file, and updates the cache.

This means only posts whose titles or tags have changed (or new posts) will trigger image generation on incremental builds.

With `verbose: true`, logs show cache source so you can verify behavior:

- `queued share-card for "slug"` *(deferred mode — call accepted into queue)*
- `flushing N queued share-card(s)...` *(deferred mode — eleventy.after flush start)*
- `build cache hit for "slug"` *(immediate mode — same hash, same build)*
- `file cache hit for "slug"`
- `cache miss for "slug" (generating...)`

### Netlify / CI

Add `_cache/share-cards.json` and your `outputDir` to your Netlify cache plugin configuration to persist the cache and generated images between deploys:

```toml
# netlify.toml
[[plugins]]
package = "netlify-plugin-cache-folder"
```

---

## How text layout works

The plugin uses a **character-width estimation** algorithm rather than full font shaping. It categorises each character into one of six width buckets (narrow punctuation, wide letters like `m`/`w`, uppercase, digits, spaces, and average lowercase) and sums them to estimate line widths. This approach:

- Requires no native addons or browser APIs
- Works accurately enough for Latin titles and tags
- Can be tuned per layer via (future) `charWidthRatio` override

If you find that a particular font renders significantly wider or narrower, open an issue or PR — the algorithm is small and easy to adjust.

---

## Migrating from `@jlengstorf/get-share-image`

`@jlengstorf/get-share-image` generates a Cloudinary URL; this plugin generates the image itself. The layer options map directly to Cloudinary's text overlay parameters:

| Cloudinary | This plugin |
|---|---|
| `cloudName` / `imagePublicID` | `baseImagePath` |
| `titleFont` | `layers[0].font` |
| `titleFontSize` | `layers[0].fontSize` |
| `titleExtraConfig: "_700_..."` | `layers[0].fontWeight: 700` |
| `titleLeftOffset` | `layers[0].x` |
| `titleBottomOffset` | `layers[0].y: { from: "bottom", value: N }` |
| `textAreaWidth` | `layers[0].maxWidth` |
| `textColor` | `layers[0].color` |
| `taglineGravity: "north_west"` | `layers[1].y: { from: "top", value: N }` |

---

## License

MIT
