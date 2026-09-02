export function favoriteKeysToPatterns(keys: Iterable<string>): string[] {
	return [...keys].map((key) => key.replace(":", "/"));
}

export function patternsToFavoriteKeys(patterns: string[]): string[] {
	return patterns.flatMap((pattern) => {
		const slash = pattern.indexOf("/");
		if (slash <= 0 || slash === pattern.length - 1) return [];
		const provider = pattern.slice(0, slash);
		const id = pattern.slice(slash + 1);
		if (provider.includes("*") || id.includes("*")) return [];
		return [`${provider}:${id}`];
	});
}

function subsequenceIndex(haystack: string, needle: string): number {
	let start = -1;
	let from = 0;
	for (const ch of needle) {
		const idx = haystack.indexOf(ch, from);
		if (idx === -1) return -1;
		if (start === -1) start = idx;
		from = idx + 1;
	}
	return start;
}

function fuzzyScore(key: string, query: string): number | null {
	const [provider = "", id = ""] = key.split(":");
	const targets = [key, provider, id, `${provider}/${id}`].map((t) => t.toLowerCase());
	let best: number | null = null;
	for (const target of targets) {
		const exact = target.indexOf(query);
		const start = exact >= 0 ? exact : subsequenceIndex(target, query);
		if (start === -1) continue;
		const score = start + (exact >= 0 ? 0 : 100);
		if (best === null || score < best) best = score;
	}
	return best;
}

export function filterFavoriteKeys(keys: string[], query: string): string[] {
	const q = query.trim().toLowerCase();
	if (!q) return keys;
	return keys
		.map((key, idx) => ({ key, idx, score: fuzzyScore(key, q) }))
		.filter((x): x is { key: string; idx: number; score: number } => x.score !== null)
		.sort((a, b) => a.score - b.score || a.idx - b.idx)
		.map((x) => x.key);
}

export function toggleIgnoredProvider(ignored: string[], name: string): string[] {
	return ignored.includes(name) ? ignored.filter((p) => p !== name) : [...ignored, name];
}

export function matchesModelIgnorePattern(id: string, pattern: string | undefined): boolean {
	return pattern !== undefined && new RegExp(pattern).test(id);
}

export function mergeFavoriteKeys(fileKeys: string[], settingsPatterns: string[]): string[] {
	const merged = [...fileKeys];
	const seen = new Set(fileKeys);
	for (const key of patternsToFavoriteKeys(settingsPatterns)) {
		if (!seen.has(key)) merged.push(key);
	}
	return merged;
}

export function shouldUseStaleCache(
	spec: { hideWhenUnreachable?: boolean },
	hasCache: boolean,
): boolean {
	return hasCache && !spec.hideWhenUnreachable;
}

export function partitionFavoriteKeys(
	favorites: Set<string>,
	available: Set<string>,
): { valid: string[]; stale: string[] } {
	const valid: string[] = [];
	const stale: string[] = [];
	for (const key of favorites) (available.has(key) ? valid : stale).push(key);
	return { valid, stale };
}
