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

describe('createGenerator', () => {
	beforeEach(() => {
		lockMock.mockClear();
		sharpMock.mockClear();
		sharpCompositeMock.mockClear();
		sharpJpegMock.mockClear();
		sharpToFileMock.mockClear();
	});

	it('generates on cache miss and writes cache entry', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const generate = createGenerator({
			baseImagePath,
			outputDir,
			outputUrlPath: '/cards',
			cacheFile,
			layers: [],
		});

		const url = await generate(['My Title'], 'my-post');

		expect(url).toBe('/cards/my-post.jpg');
		expect(sharpMock).toHaveBeenCalledTimes(1);
		expect(fs.existsSync(cacheFile)).toBe(true);

		const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
		expect(cache['my-post'].url).toBe('/cards/my-post.jpg');
		expect(cache['my-post'].hash).toHaveLength(12);
		expect(Object.keys(cache['my-post']).sort()).toEqual(['hash', 'url']);
	});

	it('skips regeneration on cache hit when output file exists', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const generate = createGenerator({
			baseImagePath,
			outputDir,
			outputUrlPath: '/cards',
			cacheFile,
			layers: [],
		});

		await generate(['My Title'], 'my-post');
		const outputPath = path.join(outputDir, 'my-post.jpg');
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(outputPath, 'image');

		const secondUrl = await generate(['My Title'], 'my-post');

		expect(secondUrl).toBe('/cards/my-post.jpg');
		expect(sharpMock).toHaveBeenCalledTimes(1);
	});

	it('returns build cache hit for repeated slug calls in the same build', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const generate = createGenerator({
			baseImagePath,
			outputDir,
			outputUrlPath: '/cards',
			cacheFile,
			layers: [],
		});

		await generate(['My Title'], 'my-post');
		await generate(['My Title'], 'my-post');

		expect(sharpMock).toHaveBeenCalledTimes(1);
		expect(lockMock).toHaveBeenCalledTimes(2);
	});

	it('can disable build cache and still use file cache', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const generate = createGenerator({
			baseImagePath,
			outputDir,
			outputUrlPath: '/cards',
			cacheFile,
			buildCache: false,
			layers: [],
		});

		await generate(['My Title'], 'my-post');
		const outputPath = path.join(outputDir, 'my-post.jpg');
		fs.mkdirSync(path.dirname(outputPath), { recursive: true });
		fs.writeFileSync(outputPath, 'image');
		await generate(['My Title'], 'my-post');

		expect(sharpMock).toHaveBeenCalledTimes(1);
		expect(lockMock).toHaveBeenCalledTimes(3);
	});

	it('logs progress when verbose is enabled', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const generate = createGenerator({
			baseImagePath,
			outputDir,
			outputUrlPath: '/cards',
			cacheFile,
			verbose: true,
			layers: [],
		});

		await generate(['My Title'], 'my-post');

		expect(logSpy).toHaveBeenCalledWith(
			'[share-card]',
			'cache miss for "my-post" (generating...)',
		);
		expect(logSpy).toHaveBeenCalledWith(
			'[share-card]',
			'generating image for "my-post"',
		);
		expect(logSpy).toHaveBeenCalledWith(
			'[share-card]',
			'cache updated for "my-post"',
		);

		await generate(['My Title'], 'my-post');
		expect(logSpy).toHaveBeenCalledWith(
			'[share-card]',
			'build cache hit for "my-post"',
		);
	});

	it('returns empty string and warns when slug is missing', async () => {
		const { baseImagePath, outputDir, cacheFile } = makeTempPaths();
		const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const generate = createGenerator({
			baseImagePath,
			outputDir,
			outputUrlPath: '/cards',
			cacheFile,
			layers: [],
		});

		const url = await generate(['My Title'], '');

		expect(url).toBe('');
		expect(sharpMock).not.toHaveBeenCalled();
		expect(warnSpy).toHaveBeenCalledTimes(1);
	});
});
