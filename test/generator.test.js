import fs from 'fs';
import os from 'os';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const lockMock = vi.fn(async () => {
	return async () => {};
});

const sharpToFileMock = vi.fn(async () => {});
const sharpJpegMock = vi.fn(() => ({
	toFile: sharpToFileMock,
}));
const sharpCompositeMock = vi.fn(() => ({
	jpeg: sharpJpegMock,
}));
const sharpMock = vi.fn(() => ({
	composite: sharpCompositeMock,
}));

vi.mock('sharp', () => ({
	default: sharpMock,
}));

vi.mock('proper-lockfile', () => ({
	default: {
		lock: lockMock,
	},
}));

const { createGenerator } = await import('../generator.js');

function makeTempPaths() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'share-card-test-'));
	const baseImagePath = path.join(root, 'base.jpg');
	const outputDir = path.join(root, 'out');
	const cacheFile = path.join(root, 'cache', 'share-cards.json');
	fs.writeFileSync(baseImagePath, 'base image');
	return { root, baseImagePath, outputDir, cacheFile };
}

/**
 * Build a minimal mock of Eleventy's UserConfig that records `eleventy.after`
 * listeners and exposes a helper to trigger them in tests.
 */
function makeEleventyConfigMock() {
	const listeners = {};
	return {
		on(event, fn) {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(fn);
		},
		async emit(event) {
			for (const fn of listeners[event] ?? []) {
				await fn();
			}
		},
	};
}

describe('createGenerator', () => {
	beforeEach(() => {
		lockMock.mockClear();
		sharpMock.mockClear();
		sharpCompositeMock.mockClear();
		sharpJpegMock.mockClear();
		sharpToFileMock.mockClear();
	});

	it('throws when eleventyConfig is not provided', () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		expect(() =>
			createGenerator({
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				layers: [],
			}),
		).toThrow('[share-card] eleventyConfig is required');
	});

	it('returns the pre-computed URL immediately without generating the image', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const eleventyConfig = makeEleventyConfigMock();

		const generate = createGenerator(
			{
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				layers: [],
			},
			eleventyConfig,
		);

		const url = await generate(['My Title'], 'my-post');

		// URL is returned right away …
		expect(url).toBe('/cards/my-post.jpg');
		// … but no image has been generated yet
		expect(sharpMock).not.toHaveBeenCalled();
		expect(lockMock).not.toHaveBeenCalled();
	});

	it('generates the image exactly once when eleventy.after fires and writes cache entry', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const eleventyConfig = makeEleventyConfigMock();

		const generate = createGenerator(
			{
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				layers: [],
			},
			eleventyConfig,
		);

		await generate(['My Title'], 'my-post');

		// No generation before the event
		expect(sharpMock).not.toHaveBeenCalled();

		await eleventyConfig.emit('eleventy.after');

		// Exactly one generation after the event
		expect(sharpMock).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(cacheFile)).toBe(true);

		const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
		expect(cache['my-post'].url).toBe('/cards/my-post.jpg');
		expect(cache['my-post'].hash).toHaveLength(12);
		expect(Object.keys(cache['my-post']).sort()).toEqual(['hash', 'url']);
	});

	it('deduplicates repeated calls for the same slug — only the last data is used', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const eleventyConfig = makeEleventyConfigMock();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		// A minimal layer so the text strings end up in the generated SVG.
		const layers = [
			{
				font: 'serif',
				fontSize: 72,
				color: '#000000',
				x: 0,
				y: 0,
				maxWidth: 1280,
			},
			{
				font: 'serif',
				fontSize: 36,
				color: '#555555',
				x: 0,
				y: 100,
				maxWidth: 1280,
			},
		];

		const generate = createGenerator(
			{
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				verbose: true,
				layers,
			},
			eleventyConfig,
		);

		// Simulate Eleventy calling eleventyComputed multiple times.
		// First pass: incomplete data (whitespace tag placeholder)
		await generate(['My Title', '  '], 'my-post');
		// Second pass: complete data
		await generate(['My Title', '#blogging'], 'my-post');
		// Third pass: same complete data again (another collection traversal)
		await generate(['My Title', '#blogging'], 'my-post');

		// Still no generation before the event
		expect(sharpMock).not.toHaveBeenCalled();

		await eleventyConfig.emit('eleventy.after');

		// Only ONE image generated despite three calls
		expect(sharpMock).toHaveBeenCalledTimes(1);

		// The SVG passed to sharp must contain the final tag text, not the
		// empty/whitespace placeholder from the first call.
		// sharpCompositeMock.mock.calls[callIndex][argIndex][layerIndex].input:
		//   [0] = first (and only) call to sharp().composite()
		//   [0] = first argument = the array of composite layers
		//   [0] = first composite layer = { input: Buffer<svg…> }
		const [[[{ input: svgBuffer }]]] = sharpCompositeMock.mock.calls;
		const svgInput = svgBuffer.toString();
		expect(svgInput).toContain('#blogging');

		// Verbose log confirms only one "generating image" entry
		const generatingLogs = logSpy.mock.calls.filter(
			(args) => args[1] === 'generating image for "my-post"',
		);
		expect(generatingLogs).toHaveLength(1);
	});

	it('handles multiple distinct slugs — each generates exactly once', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const eleventyConfig = makeEleventyConfigMock();

		const generate = createGenerator(
			{
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				layers: [],
			},
			eleventyConfig,
		);

		// Each slug is called twice (simulating two collection traversals)
		await generate(['Post A'], 'post-a');
		await generate(['Post B'], 'post-b');
		await generate(['Post A'], 'post-a');
		await generate(['Post B'], 'post-b');

		expect(sharpMock).not.toHaveBeenCalled();

		await eleventyConfig.emit('eleventy.after');

		// Two slugs → two images, not four
		expect(sharpMock).toHaveBeenCalledTimes(2);
	});

	it('skips regeneration on file cache hit when output file exists', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const eleventyConfig = makeEleventyConfigMock();

		const generate = createGenerator(
			{
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				layers: [],
			},
			eleventyConfig,
		);

		// First build: generate the image
		await generate(['My Title'], 'my-post');
		await eleventyConfig.emit('eleventy.after');
		expect(sharpMock).toHaveBeenCalledTimes(1);

		// Write a fake output file so the file-cache check succeeds
		const outputPath = path.join(outputDir, 'my-post.jpg');
		fs.writeFileSync(outputPath, 'image');

		// Second build (watch mode re-run) — same slug, same data
		await generate(['My Title'], 'my-post');
		await eleventyConfig.emit('eleventy.after');

		// File cache hit: sharp should not have been called a second time
		expect(sharpMock).toHaveBeenCalledTimes(1);
	});

	it('queue is cleared after flushing so the next build starts fresh', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const eleventyConfig = makeEleventyConfigMock();

		const generate = createGenerator(
			{
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				layers: [],
			},
			eleventyConfig,
		);

		// First build
		await generate(['My Title'], 'my-post');
		await eleventyConfig.emit('eleventy.after');
		expect(sharpMock).toHaveBeenCalledTimes(1);

		// Second eleventy.after with nothing newly queued should not regenerate
		await eleventyConfig.emit('eleventy.after');
		expect(sharpMock).toHaveBeenCalledTimes(1);
	});

	it('returns empty string and warns when slug is missing', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const eleventyConfig = makeEleventyConfigMock();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

		const generate = createGenerator(
			{
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				layers: [],
			},
			eleventyConfig,
		);

		const url = await generate(['My Title'], '');

		expect(url).toBe('');
		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(sharpMock).not.toHaveBeenCalled();
	});

	it('logs verbose queue and flush messages when verbose is enabled', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const eleventyConfig = makeEleventyConfigMock();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

		const generate = createGenerator(
			{
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				verbose: true,
				layers: [],
			},
			eleventyConfig,
		);

		await generate(['My Title'], 'my-post');

		expect(logSpy).toHaveBeenCalledWith(
			'[share-card]',
			'queued share-card for "my-post"',
		);

		await eleventyConfig.emit('eleventy.after');

		expect(logSpy).toHaveBeenCalledWith(
			'[share-card]',
			'flushing 1 queued share-card(s)...',
		);
		expect(logSpy).toHaveBeenCalledWith(
			'[share-card]',
			'cache miss for "my-post" (generating...)',
		);
		expect(logSpy).toHaveBeenCalledWith(
			'[share-card]',
			'generated: my-post -> /cards/my-post.jpg',
		);
	});

	it('retries a failed slug on the next eleventy.after (watch mode)', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const eleventyConfig = makeEleventyConfigMock();
		const errorSpy = vi
			.spyOn(console, 'error')
			.mockImplementation(() => {});

		const generate = createGenerator(
			{
				baseImagePath,
				outputDir,
				outputUrlPath: '/cards',
				cacheFile,
				layers: [],
			},
			eleventyConfig,
		);

		await generate(['My Title'], 'my-post');

		// Make sharp fail on the first flush
		sharpToFileMock.mockRejectedValueOnce(new Error('disk full'));

		await eleventyConfig.emit('eleventy.after');

		// sharp was called once but failed — slug stays in the queue
		expect(sharpMock).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalledTimes(1);

		// Second build cycle: template re-queues the slug (last-write-wins)
		await generate(['My Title'], 'my-post');

		// This time sharp succeeds
		await eleventyConfig.emit('eleventy.after');
		expect(sharpMock).toHaveBeenCalledTimes(2);
	});
});
