import { describe, expect, test } from "bun:test";
import { filterFavoriteKeys, mergeFavoriteKeys, patternsToFavoriteKeys, partitionFavoriteKeys, shouldUseStaleCache, toggleIgnoredProvider } from "./settings";

describe("patternsToFavoriteKeys", () => {
	test("splits provider from model on the first slash and preserves colons in ids", () => {
		expect(
			patternsToFavoriteKeys(["anthropic/claude-opus-4", "ollama/qwen3:latest"]),
		).toEqual(["anthropic:claude-opus-4", "ollama:qwen3:latest"]);
	});

	test("drops wildcard and malformed patterns", () => {
		expect(patternsToFavoriteKeys(["claude-*", "nope", "google/gemma*"])).toEqual([]);
	});
});

describe("filterFavoriteKeys", () => {
	const keys = [
		"anthropic:claude-opus-4",
		"aihub:kimi-k3",
		"ollama:qwen3:latest",
		"google:gemma-4-31b-it",
	];

	test("substring matches against provider, id, or combined", () => {
		expect(filterFavoriteKeys(keys, "kimi")).toEqual(["aihub:kimi-k3"]);
		expect(filterFavoriteKeys(keys, "claude")).toEqual(["anthropic:claude-opus-4"]);
		expect(filterFavoriteKeys(keys, "google/gemma")).toEqual(["google:gemma-4-31b-it"]);
		expect(filterFavoriteKeys(keys, "")).toEqual(keys);
	});

	test("fuzzy subsequence matches out of order characters", () => {
		expect(filterFavoriteKeys(keys, "km3")).toEqual(["aihub:kimi-k3"]);
		expect(filterFavoriteKeys(keys, "kmk")).toEqual(["aihub:kimi-k3"]);
	});

	test("ranks exact substring before fuzzy", () => {
		expect(
			filterFavoriteKeys(["aihub:kimi-k3", "other:ki-mi-backup"], "kimi")[0],
		).toBe("aihub:kimi-k3");
	});

	test("no match returns empty", () => {
		expect(filterFavoriteKeys(keys, "zzz")).toEqual([]);
	});
});

describe("toggleIgnoredProvider", () => {
	test("adds then removes a provider, preserving order", () => {
		expect(toggleIgnoredProvider(["aihub"], "ollama")).toEqual(["aihub", "ollama"]);
		expect(toggleIgnoredProvider(["aihub", "ollama"], "aihub")).toEqual(["ollama"]);
	});
});

describe("mergeFavoriteKeys", () => {
	test("unions file keys and settings patterns, file order first, deduped", () => {
		expect(
			mergeFavoriteKeys(
				["aihub:kimi-k3", "anthropic:claude-opus-4"],
				["anthropic/claude-opus-4", "ollama/qwen3:latest"],
			),
		).toEqual(["aihub:kimi-k3", "anthropic:claude-opus-4", "ollama:qwen3:latest"]);
	});
});

describe("shouldUseStaleCache", () => {
	test("uses stale cache only when it exists and provider is not hidden", () => {
		expect(shouldUseStaleCache({}, true)).toBe(true);
		expect(shouldUseStaleCache({}, false)).toBe(false);
		expect(shouldUseStaleCache({ hideWhenUnreachable: true }, true)).toBe(false);
	});
});

describe("partitionFavoriteKeys", () => {
	test("splits valid and stale keys in insertion order", () => {
		const favorites = new Set([
			"anthropic:claude-opus-4",
			"aihub:stale-model",
			"ollama:qwen3:latest",
		]);
		const available = new Set(["anthropic:claude-opus-4", "ollama:qwen3:latest"]);
		expect(partitionFavoriteKeys(favorites, available)).toEqual({
			valid: ["anthropic:claude-opus-4", "ollama:qwen3:latest"],
			stale: ["aihub:stale-model"],
		});
	});
});
