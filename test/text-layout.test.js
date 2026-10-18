import { describe, expect, it } from 'vitest';
import {
	buildTextElements,
	estimateTextWidth,
	wrapText,
} from '../text-layout.js';

const url =
	'https://example.com/blog/2026/10/a-reasonably-long-post-slug-goes-here';

function expectWidthsWithin(lines, maxWidth, fontSize, charWidthRatio = 1) {
	for (const line of lines) {
		expect(
			estimateTextWidth(line, fontSize) * charWidthRatio,
		).toBeLessThanOrEqual(maxWidth);
	}
}

describe('wrapText', () => {
	it.each([
		[10, 1],
		[20, 1],
		[40, 2],
		[80, 4],
		[160, 8],
	])(
		'wraps a sole token of %i wide letters into %i lines',
		(length, count) => {
			const text = 'W'.repeat(length);
			const lines = wrapText(text, 600, 40);

			expect(lines).toHaveLength(count);
			expect(lines.join('')).toBe(text);
			expectWidthsWithin(lines, 600, 40);
		},
	);

	it.each([
		['first', `${'W'.repeat(40)} x`, ['W'.repeat(20), 'W'.repeat(20), 'x']],
		['last', `x ${'W'.repeat(40)}`, ['x', 'W'.repeat(20), 'W'.repeat(20)]],
		[
			'middle',
			`x ${'W'.repeat(40)} y`,
			['x', 'W'.repeat(20), 'W'.repeat(20), 'y'],
		],
	])('hard-breaks an oversized %s word', (_position, text, expected) => {
		const lines = wrapText(text, 600, 40);

		expect(lines).toEqual(expected);
		expectWidthsWithin(lines, 600, 40);
	});

	it.each(['', 'Read: '])('wraps a URL with prefix "%s"', (prefix) => {
		const lines = wrapText(prefix + url, 600, 40);

		expectWidthsWithin(lines, 600, 40);
		expect(lines.join('').replaceAll(' ', '')).toBe(
			(prefix + url).replaceAll(' ', ''),
		);
		expect(lines).toHaveLength(prefix ? 4 : 3);
	});

	it('keeps the existing prefixed long-token behavior', () => {
		const lines = wrapText(`x ${'W'.repeat(160)}`, 600, 40);

		expect(lines).toEqual(['x', ...Array(8).fill('W'.repeat(20))]);
	});

	it('wraps consecutive long words without losing their remainders', () => {
		const lines = wrapText(
			`${'W'.repeat(21)} ${'W'.repeat(21)} x`,
			600,
			40,
		);

		expect(lines).toEqual(['W'.repeat(20), 'W', 'W'.repeat(20), 'W x']);
		expectWidthsWithin(lines, 600, 40);
	});

	it('lets the next word share space with the last hard-broken chunk', () => {
		expect(wrapText(`${'W'.repeat(21)} x`, 600, 40)).toEqual([
			'W'.repeat(20),
			'W x',
		]);
	});

	it.each([0.5, 1, 1.25, 2])(
		'applies charWidthRatio=%s to hard breaks',
		(ratio) => {
			const text = 'W'.repeat(80);
			const lines = wrapText(text, 600, 40, ratio);

			expect(lines).toEqual(
				Array(4 * ratio).fill('W'.repeat(20 / ratio)),
			);
			expectWidthsWithin(lines, 600, 40, ratio);
			expect(lines.join('')).toBe(text);
		},
	);

	it.each(['', ' \t\n '])('returns one empty line for %j', (text) => {
		expect(wrapText(text, 600, 40)).toEqual(['']);
	});

	it('preserves ordinary greedy wrapping and normalizes whitespace', () => {
		expect(wrapText('  one\t two\nthree  ', 150, 40)).toEqual([
			'one two',
			'three',
		]);
	});

	it('keeps a line exactly at the estimated width limit', () => {
		const text = 'one two';
		expect(wrapText(text, estimateTextWidth(text, 40), 40)).toEqual([text]);
	});

	it('scales spaces as well as word widths', () => {
		expect(wrapText('W W', 100, 40, 2)).toEqual(['W', 'W']);
	});

	it.each([
		['surrogate pairs', '\u{1f680}', 55],
		['combining sequences', 'e\u0301', 70],
		['joined emoji', '\u{1f469}\u200d\u{1f680}', 100],
		['emoji with skin tones', '\u{1f44d}\u{1f3fd}', 70],
		['flags', '\u{1f1ec}\u{1f1e7}', 70],
	])('preserves %s at every hard break', (_label, grapheme, maxWidth) => {
		const text = grapheme.repeat(12);
		const lines = wrapText(text, maxWidth, 40);

		expect(lines.join('')).toBe(text);
		expect(lines.length).toBeGreaterThan(1);
		expectWidthsWithin(lines, maxWidth, 40);
		for (const line of lines) {
			expect(line.length % grapheme.length).toBe(0);
			expect(line).toBe(grapheme.repeat(line.length / grapheme.length));
		}
	});

	it('keeps an individually oversized grapheme intact on its own line', () => {
		const grapheme = '\u{1f469}\u200d\u{1f680}';
		const lines = wrapText(`x ${grapheme.repeat(2)} y`, 30, 40);

		expect(lines).toEqual(['x', grapheme, grapheme, 'y']);
		expect(estimateTextWidth(grapheme, 40)).toBeGreaterThan(30);
	});
});

describe('buildTextElements', () => {
	it.each([
		[{ from: 'top', value: 20 }, ['60.00', '108.00']],
		[{ from: 'bottom', value: 20 }, ['532.00', '580.00']],
	])('renders wrapped lines with %j positioning', (y, baselines) => {
		const svg = buildTextElements(
			{ fontSize: 40, maxWidth: 600, x: 10, y },
			'W'.repeat(40),
			600,
		);

		expect(svg.match(/<text /g)).toHaveLength(2);
		for (const baseline of baselines) {
			expect(svg).toContain(`x="10" y="${baseline}"`);
		}
		expect(svg.match(/>W{20}<\/text>/g)).toHaveLength(2);
	});

	it('keeps XML escaping when an oversized token is wrapped', () => {
		const svg = buildTextElements(
			{ fontSize: 40, maxWidth: 600 },
			`${'W'.repeat(21)}<&`,
			600,
		);

		expect(svg.match(/<text /g)).toHaveLength(2);
		expect(svg).toContain('>W&lt;&amp;</text>');
	});
});
