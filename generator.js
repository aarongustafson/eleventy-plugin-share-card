/**
 * Core share-card image generator.
 *
 * Creates a JPEG share-card by compositing SVG text layers over a base image
 * using sharp. Fonts are embedded directly in the SVG as base64 data URIs so
 * the generator works in any Node.js environment without system-level font
 * installation.
 *
 * All I/O (reading the base image, writing output files, reading/writing the
 * cache) is done here so the generator module is the single place that touches
 * the filesystem.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import lockfile from 'proper-lockfile';
import sharp from 'sharp';
import { buildTextElements, escapeXml } from './text-layout.js';

// ---------------------------------------------------------------------------
// Cache helpers
// ---------------------------------------------------------------------------

/**
 * Load the JSON cache from disk.
 * Returns an empty object when the file doesn't exist or is unreadable.
 *
 * @param {string} cacheFile - absolute or relative path to the JSON cache file
 * @returns {Record<string, {hash:string, url:string}>}
 */
function loadCache(cacheFile) {
	try {
		return JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
	} catch {
		return {};
	}
}

/**
 * Resolve the lock file path used to coordinate cache access.
 *
 * @param {string} cacheFile
 * @returns {string}
 */
function getCacheLockFile(cacheFile) {
	return `${cacheFile}.lock`;
}

/**
 * Persist the cache object to disk.
 *
 * @param {string} cacheFile
 * @param {object} cache
 */
function saveCache(cacheFile, cache) {
	try {
		fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
		const tmpFile = `${cacheFile}.${process.pid}.tmp`;
		fs.writeFileSync(tmpFile, JSON.stringify(cache, null, 2));
		fs.renameSync(tmpFile, cacheFile);
	} catch (err) {
		console.error('[share-card] Could not write cache:', err.message);
	}
}

/**
 * Run a callback while holding an exclusive lock for this cache file.
 *
 * @template T
 * @param {string} cacheFile
 * @param {(cache: Record<string, {hash:string, url:string}>) => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function withCacheLock(cacheFile, callback) {
	const lockFile = getCacheLockFile(cacheFile);
	fs.mkdirSync(path.dirname(lockFile), { recursive: true });
	if (!fs.existsSync(lockFile)) {
		fs.writeFileSync(lockFile, '');
	}

	const release = await lockfile.lock(lockFile, {
		realpath: false,
		retries: {
			retries: 20,
			factor: 1.2,
			minTimeout: 25,
			maxTimeout: 250,
		},
	});

	try {
		const cache = loadCache(cacheFile);
		return await callback(cache);
	} finally {
		await release();
	}
}

// ---------------------------------------------------------------------------
// Font embedding
// ---------------------------------------------------------------------------

/**
 * Read a font file and return a base64 data URI string, or an empty string if
 * the path cannot be resolved or the file is missing.
 *
 * Supports both absolute paths and paths relative to process.cwd().
 *
 * @param {string} fontPath
 * @returns {string} base64 data URI or ''
 */
function loadFontAsDataUri(fontPath) {
	if (!fontPath) return '';

	const resolved = path.isAbsolute(fontPath)
		? fontPath
		: path.resolve(process.cwd(), fontPath);

	try {
		const data = fs.readFileSync(resolved);
		const ext = path.extname(resolved).toLowerCase().slice(1);
		const mime =
			ext === 'woff2'
				? 'font/woff2'
				: ext === 'woff'
					? 'font/woff'
					: ext === 'ttf'
						? 'font/ttf'
						: ext === 'otf'
							? 'font/otf'
							: 'font/ttf';
		return `data:${mime};base64,${data.toString('base64')}`;
	} catch {
		return '';
	}
}

// ---------------------------------------------------------------------------
// SVG builder
// ---------------------------------------------------------------------------

/**
 * Build the full SVG overlay string for all configured text layers.
 *
 * @param {object[]} layers - layer configs (each with resolved fontData if any)
 * @param {string[]} texts  - one text string per layer, in order
 * @param {object}   dims   - { imageWidth, imageHeight }
 * @returns {string} SVG markup
 */
function buildSvg(layers, texts, { imageWidth, imageHeight }) {
	// Collect @font-face declarations
	const fontFaces = layers
		.filter((l, i) => l.fontData && texts[i])
		.map((l) => {
			return `\t\t@font-face { font-family: '${escapeXml(l.font)}'; font-weight: ${l.fontWeight ?? 400}; src: url('${l.fontData}') format('${l.fontFormat ?? 'woff2'}'); }`;
		})
		.join('\n');

	// Build text element groups
	const textMarkup = layers
		.map((layer, i) => {
			const text = texts[i];
			if (!text) return '';
			return buildTextElements(layer, text, imageHeight);
		})
		.filter(Boolean)
		.join('\n');

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${imageWidth}" height="${imageHeight}" overflow="hidden">`,
		fontFaces
			? `\t<defs>\n\t\t<style>\n${fontFaces}\n\t\t</style>\n\t</defs>`
			: '',
		textMarkup,
		'</svg>',
	]
		.filter(Boolean)
		.join('\n');
}

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------

/**
 * Compute a short SHA-256 hex digest from the combined text strings plus a
 * config salt.  The config salt captures the layer settings (font, size,
 * positions, options) so that any change to the generator configuration
 * invalidates the cache and forces images to be regenerated — even when the
 * source text itself hasn't changed.
 *
 * @param {string[]} texts
 * @param {string}   configSalt - stable string representing the current layer config
 * @returns {string} first 12 hex chars of the SHA-256 digest
 */
function contentHash(texts, configSalt = '') {
	return crypto
		.createHash('sha256')
		.update(texts.join('\x00') + '\x01' + configSalt)
		.digest('hex')
		.slice(0, 12);
}

/**
 * Produce a stable string that summarises the layer configuration.
 * Changes to any layer property (font, size, positions, flags …) will
 * produce a different salt, causing all cached images to be regenerated.
 *
 * We deliberately exclude `fontData` (the base64 blob) to keep this fast.
 *
 * @param {object[]} layers
 * @returns {string}
 */
function layerConfigSalt(layers) {
	const summary = layers.map(({ fontData: _fd, ...rest }) => rest);
	return JSON.stringify(summary);
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Create a share-card generator function bound to a specific configuration.
 *
 * Call this once (e.g. inside your Eleventy config or a data file) and re-use
 * the returned async function for every post/page.
 *
 * Every call to the returned function is queued (last write wins per slug) so
 * that images are generated exactly once per slug at the end of the build via
 * Eleventy's `eleventy.after` event.  This prevents the redundant
 * double-generation that occurs because Eleventy re-evaluates `eleventyComputed`
 * properties on every collection access — sometimes with incomplete data on the
 * first pass.
 *
 * @param {object} options
 * @param {string}   options.baseImagePath  - path to the template JPEG/PNG
 * @param {string}   options.outputDir      - directory to write generated images into
 * @param {string}   options.outputUrlPath  - URL prefix used in the returned path  (e.g. '/i/share-cards')
 * @param {string}  [options.cacheFile]     - path to JSON cache (default: './_cache/share-cards.json')
 * @param {number}  [options.imageWidth]    - base image width  (default: 1280)
 * @param {number}  [options.imageHeight]   - base image height (default: 669)
 * @param {number}  [options.jpegQuality]   - output JPEG quality 1-100 (default: 90)
 * @param {boolean} [options.verbose]       - log cache/generation events to console (default: false)
 * @param {object[]} options.layers         - text layer configs (see README for full shape)
 * @param {object}   eleventyConfig         - Eleventy UserConfig object (required); used to
 *                                           register the `eleventy.after` flush handler
 *
 * Each layer object supports:
 * @param {string}  layer.font        - CSS font-family name
 * @param {string} [layer.fontPath]   - path to a WOFF2/TTF/OTF font file to embed
 * @param {number}  layer.fontSize    - font size in pixels
 * @param {number} [layer.fontWeight] - CSS font-weight (default: 400)
 * @param {string} [layer.color]      - hex color, with or without '#' (default: '#000000')
 * @param {number}  layer.x           - left offset in pixels
 * @param {number|{from:'top'|'bottom', value:number}} layer.y - vertical position
 * @param {number}  layer.maxWidth    - text-area width for word-wrapping in pixels
 * @param {number} [layer.lineSpacing] - extra pixels between lines, may be negative (default: 0)
 *
 * @returns {function(texts: string[], slug: string): Promise<string>}
 *   Async function that accepts an array of text strings (one per layer) and a
 *   unique slug for the output filename. Returns the public URL of the image.
 */
export function createGenerator(options = {}, eleventyConfig) {
	const {
		baseImagePath,
		outputDir,
		outputUrlPath,
		cacheFile = './_cache/share-cards.json',
		imageWidth = 1280,
		imageHeight = 669,
		jpegQuality = 90,
		verbose = false,
		layers = [],
	} = options;

	const log = (...args) => {
		if (verbose) {
			console.log('[share-card]', ...args);
		}
	};

	if (!baseImagePath)
		throw new Error('[share-card] options.baseImagePath is required');
	if (!outputDir)
		throw new Error('[share-card] options.outputDir is required');
	if (!outputUrlPath)
		throw new Error('[share-card] options.outputUrlPath is required');
	if (!eleventyConfig || typeof eleventyConfig.on !== 'function')
		throw new Error(
			'[share-card] eleventyConfig is required. Pass the Eleventy UserConfig object as the second argument to createGenerator().',
		);

	// Resolve the base image path once
	const resolvedBaseImage = path.isAbsolute(baseImagePath)
		? baseImagePath
		: path.resolve(process.cwd(), baseImagePath);

	// Pre-load fonts and attach them to the layer configs
	const preparedLayers = layers.map((layer) => {
		const fontData = loadFontAsDataUri(layer.fontPath);
		const ext = layer.fontPath
			? path.extname(layer.fontPath).toLowerCase().slice(1)
			: 'woff2';
		const fontFormat =
			ext === 'woff2'
				? 'woff2'
				: ext === 'woff'
					? 'woff'
					: ext === 'ttf'
						? 'truetype'
						: ext === 'otf'
							? 'opentype'
							: 'woff2';
		return { ...layer, fontData, fontFormat };
	});

	// Stable salt derived from layer configuration.  Any change to the layer
	// options (font, size, positions, flags …) will produce a different salt
	// so previously-cached images are automatically regenerated.
	const configSalt = layerConfigSalt(preparedLayers);

	// Ensure output directory exists
	fs.mkdirSync(path.resolve(process.cwd(), outputDir), { recursive: true });

	// slug → texts (most recent call wins).
	// Populated during the build; flushed once in the eleventy.after handler.
	const buildQueue = new Map();

	// ---------------------------------------------------------------------------
	// Core generation logic
	// ---------------------------------------------------------------------------

	/**
	 * Generate one share-card image (or return a cached URL).
	 * This function always generates immediately — callers are responsible for
	 * any deduplication / queueing that should happen before this is invoked.
	 *
	 * @param {string[]} texts
	 * @param {string}   slug
	 * @returns {Promise<string>}
	 */
	async function generateImage(texts, slug) {
		const hash = contentHash(texts, configSalt);
		const filename = `${slug}.jpg`;
		const outputPath = path.resolve(process.cwd(), outputDir, filename);
		const publicUrl = `${outputUrlPath.replace(/\/$/, '')}/${filename}`;

		// Check the file cache under lock so parallel contexts don't clobber each other.
		const cachedUrl = await withCacheLock(cacheFile, async (cache) => {
			if (cache[slug]?.hash === hash && fs.existsSync(outputPath)) {
				log(`file cache hit for "${slug}"`);
				return cache[slug].url || publicUrl;
			}
			log(`cache miss for "${slug}" (generating...)`);
			return '';
		});
		if (cachedUrl) return cachedUrl;

		// Generate the SVG overlay
		const svg = buildSvg(preparedLayers, texts, {
			imageWidth,
			imageHeight,
		});

		try {
			log(`generating image for "${slug}"`);
			await sharp(resolvedBaseImage)
				.composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
				.jpeg({
					quality: jpegQuality,
					progressive: true,
					mozjpeg: true,
				})
				.toFile(outputPath);

			// Update the cache under lock. Re-check first in case another context
			// already generated this slug while we were rendering the image.
			await withCacheLock(cacheFile, async (cache) => {
				if (cache[slug]?.hash === hash && fs.existsSync(outputPath)) {
					log(`cache already updated for "${slug}" while generating`);
					return;
				}

				cache[slug] = {
					hash,
					url: publicUrl,
				};
				saveCache(cacheFile, cache);
				log(`cache updated for "${slug}"`);
			});
			log(`generated: ${slug} -> ${publicUrl}`);
		} catch (err) {
			console.error(
				`[share-card] Failed to generate image for "${slug}":`,
				err.message,
			);
			return '';
		}

		return publicUrl;
	}

	// ---------------------------------------------------------------------------
	// Register eleventy.after hook to flush the build queue once per build
	// ---------------------------------------------------------------------------

	eleventyConfig.on('eleventy.after', async () => {
		if (buildQueue.size === 0) return;

		log(`flushing ${buildQueue.size} queued share-card(s)...`);

		// Snapshot and clear the queue before processing so that any new
		// calls queued during the flush (unlikely but possible) start a
		// fresh queue for the next build cycle.
		const entries = [...buildQueue];
		buildQueue.clear();

		for (const [slug, texts] of entries) {
			await generateImage(texts, slug);
		}
	});

	// ---------------------------------------------------------------------------
	// Returned generator function
	// ---------------------------------------------------------------------------

	/**
	 * Queue a share-card image for generation at the end of the build.
	 *
	 * Each call stores the most recent texts for the given slug.  When the same
	 * slug is called multiple times during a build (because Eleventy re-evaluates
	 * `eleventyComputed` properties for every collection access), only the last
	 * call's data is used — ensuring the image is always generated with the most
	 * complete data.  The pre-computed URL is returned immediately so template
	 * rendering can continue; the image file itself is written by the
	 * `eleventy.after` handler registered above.
	 *
	 * @param {string[]} texts - one string per layer, in the same order as `layers`
	 * @param {string}   slug  - unique identifier used as the output filename
	 * @returns {Promise<string>} public URL path to the generated image (e.g. '/i/share-cards/my-post.jpg')
	 */
	return async function generateShareCard(texts, slug) {
		if (!slug) {
			console.warn(
				'[share-card] No slug provided; skipping image generation.',
			);
			return '';
		}

		const filename = `${slug}.jpg`;
		const publicUrl = `${outputUrlPath.replace(/\/$/, '')}/${filename}`;

		buildQueue.set(slug, texts);
		log(`queued share-card for "${slug}"`);
		return publicUrl;
	};
}
