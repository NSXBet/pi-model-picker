/**
 * Model Picker Extension
 *
 * Categorized, keyboard-driven model selector with per-category search.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────┐
 *   │  Select Model                                   │
 *   ├─────────────────────────────────────────────────┤
 *   │◀  Anthropic │ Google │ OpenAI │ … ▶             │  ← Tab/Shift+Tab or ←→ at edges
 *   ├─────────────────────────────────────────────────┤
 *   │  Search: claude_                                │  ← type to filter this category
 *   ├─────────────────────────────────────────────────┤
 *   │▶ Claude Sonnet 4.6 ●            200k  thinking  │
 *   │  Claude Opus 4.5                200k  thinking  │
 *   ├─────────────────────────────────────────────────┤
 *   │  ↑↓ navigate · Tab/← → category · esc cancel   │
 *   └─────────────────────────────────────────────────┘
 *
 * Usage:
 *   /models          — open the categorized picker
 *   Ctrl+Shift+M     — keyboard shortcut
 *
 * Note: /model is a built-in pi command and cannot be overridden.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Input, Key, Text, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import path from "node:path";

// ─── list persistence ──────────────────────────────────────────────────────

const FAVORITES_CATEGORY = "★ Favorites";
const HIDDEN_CATEGORY = "◌ Hidden";
const ALL_CATEGORY = "✓ All";
const STORAGE_DIR = join(homedir(), ".pi", "agent", "extensions", "pi-model-picker");
const FAVORITES_FILE = join(STORAGE_DIR, "favorites.json");
const HIDDEN_FILE = join(STORAGE_DIR, "hidden.json");

function modelKey(m: Model<Api>): string {
	return `${m.provider}:${m.id}`;
}

function loadModelKeys(file: string): Set<string> {
	try {
		if (!existsSync(file)) return new Set();
		const raw = readFileSync(file, "utf8");
		const arr = JSON.parse(raw);
		return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
	} catch {
		return new Set();
	}
}

function saveModelKeys(file: string, keys: Set<string>): void {
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify([...keys], null, 2), "utf8");
	} catch {
		// best-effort persistence; ignore disk errors
	}
}

function loadFavorites(): Set<string> {
	return loadModelKeys(FAVORITES_FILE);
}

function saveFavorites(favs: Set<string>): void {
	saveModelKeys(FAVORITES_FILE, favs);
}

function loadHidden(): Set<string> {
	return loadModelKeys(HIDDEN_FILE);
}

function saveHidden(hidden: Set<string>): void {
	saveModelKeys(HIDDEN_FILE, hidden);
}

// ─── helpers ────────────────────────────────────────────────────────────────

/** Friendly display name for a provider id — derived from the id itself, no hardcoding */
function providerLabel(id: string): string {
	return id
		.split("-")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

/** Format context window as human-readable */
function fmtCtx(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}k`;
	return String(tokens);
}

// ─── component ──────────────────────────────────────────────────────────────

interface ModelPickerOptions {
	allModels: Model<Api>[];
	currentModel: Model<Api> | undefined;
	onSelect: (model: Model<Api>) => void;
	onCancel: () => void;
}

class ModelPickerComponent {
	// Focusable — needed so the Input inside gets IME cursor positioning
	focused = false;

	private categories: string[];
	private catIndex: number;
	private rowIndex = 0;

	// per-category source models (sorted, never mutated)
	private byCategory: Map<string, Model<Api>[]>;

	// favorite model keys ("provider:id") — persisted to disk
	private favorites: Set<string>;

	// hidden model keys ("provider:id") — persisted to disk
	private hidden: Set<string>;

	// whether to show the Hidden category tab
	private showHiddenTab = false;

	// filters
	private filterThinking: boolean | null = null;
	private filterVision: boolean | null = null;
	private filterMinTokens: number | null = null;
	private filterMaxTokens: number | null = null;

	// per-category search terms (reset when category changes, preserved when returning)
	private searchTerms: Map<string, string> = new Map();

	// the search Input widget
	private searchInput: Input;

	// filtered models for the current view (recomputed on query/category change)
	private filteredRows: Model<Api>[] = [];

	constructor(private opts: ModelPickerOptions) {
		this.favorites = loadFavorites();
		this.hidden = loadHidden();
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());

		// Always start on the Favorites category (index 0)
		this.catIndex = 0;

		// Build the search Input
		this.searchInput = new Input();
		this.searchInput.focused = true;
		this.searchInput.onEscape = () => {
			// If there's typed text, clear it instead of exiting
			if (this.searchInput.getValue().length > 0) {
				const catKey = this.categories[this.catIndex] ?? "";
				this.searchInput.setValue("");
				this.searchTerms.set(catKey, "");
				this.rowIndex = 0;
				this.applyFilter();
			} else {
				opts.onCancel();
			}
		};
		this.searchInput.onSubmit = () => {
			const selected = this.filteredRows[this.rowIndex];
			if (selected) opts.onSelect(selected);
		};

		// Initialise filtered rows and pre-select current model if visible in this category
		this.applyFilter();
		const cur = this.opts.currentModel;
		if (cur) {
			const idx = this.filteredRows.findIndex(
				(m) => m.id === cur.id && m.provider === cur.provider,
			);
			if (idx >= 0) this.rowIndex = idx;
		}
	}

	// ── public Focusable propagation ─────────────────────────────────────
	set focusedState(v: boolean) {
		this.focused = v;
		this.searchInput.focused = v;
	}

	// ── category building ────────────────────────────────────────────────

	private buildCategories(): Map<string, Model<Api>[]> {
		const map = new Map<string, Model<Api>[]>();
		for (const m of this.opts.allModels) {
			if (this.hidden.has(modelKey(m))) continue;
			if (!map.has(m.provider)) map.set(m.provider, []);
			map.get(m.provider)!.push(m);
		}

		const cur = this.opts.currentModel;

		// Sort models within each category: active first, then alphabetical
		for (const [, arr] of map) {
			arr.sort((a, b) => {
				const aCur = cur && a.id === cur.id && a.provider === cur.provider ? -1 : 0;
				const bCur = cur && b.id === cur.id && b.provider === cur.provider ? -1 : 0;
				if (aCur !== bCur) return aCur - bCur;
				return a.name.localeCompare(b.name);
			});
		}

		// Sort providers: active provider first, then alphabetical
		const providerEntries = [...map.entries()].sort(([aKey], [bKey]) => {
			const aCur = cur && aKey === cur.provider ? -1 : 0;
			const bCur = cur && bKey === cur.provider ? -1 : 0;
			if (aCur !== bCur) return aCur - bCur;
			return aKey.localeCompare(bKey);
		});

		// Favorites and Hidden are cross-provider lists pulled from saved keys
		const entries: [string, Model<Api>[]][] = [
			[FAVORITES_CATEGORY, this.computeFavoriteModels()],
		];
		if (this.showHiddenTab) {
			entries.push([HIDDEN_CATEGORY, this.computeHiddenModels()]);
		}
		entries.push(...providerEntries);
		entries.push([ALL_CATEGORY, this.computeAllModels()]);
		return new Map<string, Model<Api>[]>(entries);
	}

	private computeFavoriteModels(): Model<Api>[] {
		return this.sortModels(
			this.opts.allModels.filter(
				(m) => this.favorites.has(modelKey(m)) && !this.hidden.has(modelKey(m)),
			),
		);
	}

	private computeHiddenModels(): Model<Api>[] {
		return this.sortModels(this.opts.allModels.filter((m) => this.hidden.has(modelKey(m))));
	}

	private sortModels(models: Model<Api>[]): Model<Api>[] {
		const cur = this.opts.currentModel;
		return [...models].sort((a, b) => {
			const aCur = cur && a.id === cur.id && a.provider === cur.provider ? -1 : 0;
			const bCur = cur && b.id === cur.id && b.provider === cur.provider ? -1 : 0;
			if (aCur !== bCur) return aCur - bCur;
			return a.name.localeCompare(b.name);
		});
	}

	private computeAllModels(): Model<Api>[] {
		return this.sortModels([...this.opts.allModels]);
	}

	// ── favorites toggle ────────────────────────────────────────────────

	private toggleFavorite(): void {
		const selected = this.filteredRows[this.rowIndex];
		if (!selected) return;

		const key = modelKey(selected);
		if (this.favorites.has(key)) this.favorites.delete(key);
		else this.favorites.add(key);
		saveFavorites(this.favorites);

		this.refreshCategories();
	}

	// ── hidden toggle ────────────────────────────────────────────────────

	private toggleHidden(): void {
		const selected = this.filteredRows[this.rowIndex];
		if (!selected) return;

		const key = modelKey(selected);
		if (this.hidden.has(key)) this.hidden.delete(key);
		else this.hidden.add(key);
		saveHidden(this.hidden);

		this.refreshCategories();
	}

	private refreshCategories(): void {
		const currentCategory = this.categories[this.catIndex] ?? FAVORITES_CATEGORY;
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());
		this.catIndex = Math.max(0, this.categories.indexOf(currentCategory));
		this.applyFilter();
	}

	private toggleHiddenTab(): void {
		this.showHiddenTab = !this.showHiddenTab;
		const currentCategory = this.categories[this.catIndex] ?? FAVORITES_CATEGORY;
		this.byCategory = this.buildCategories();
		this.categories = Array.from(this.byCategory.keys());

		// If we just hid the tab and we were on it, switch to Favorites
		if (!this.showHiddenTab && currentCategory === HIDDEN_CATEGORY) {
			this.catIndex = this.categories.indexOf(FAVORITES_CATEGORY);
		} else {
			this.catIndex = Math.max(0, this.categories.indexOf(currentCategory));
		}
		this.applyFilter();
	}

	// ── filtering ────────────────────────────────────────────────────────

	private cycleThinkingFilter(): void {
		if (this.filterThinking === null) this.filterThinking = true;
		else if (this.filterThinking === true) this.filterThinking = false;
		else this.filterThinking = null;
		this.rowIndex = 0;
		this.applyFilter();
	}

	private cycleVisionFilter(): void {
		if (this.filterVision === null) this.filterVision = true;
		else if (this.filterVision === true) this.filterVision = false;
		else this.filterVision = null;
		this.rowIndex = 0;
		this.applyFilter();
	}

	private TOKEN_STEPS = [null, 4_000, 8_000, 32_000, 128_000, 1_000_000, 2_000_000];

	private decreaseTokenFilter(): void {
		const currentIdx = this.TOKEN_STEPS.indexOf(this.filterMaxTokens);
		if (currentIdx > 0) {
			this.filterMaxTokens = this.TOKEN_STEPS[currentIdx - 1];
		} else {
			this.filterMaxTokens = null;
		}
		this.rowIndex = 0;
		this.applyFilter();
	}

	private increaseTokenFilter(): void {
		const currentIdx = this.TOKEN_STEPS.indexOf(this.filterMaxTokens);
		if (currentIdx < this.TOKEN_STEPS.length - 1) {
			this.filterMaxTokens = this.TOKEN_STEPS[currentIdx + 1] ?? null;
		}
		this.rowIndex = 0;
		this.applyFilter();
	}

	private clearFilters(): void {
		this.filterThinking = null;
		this.filterVision = null;
		this.filterMaxTokens = null;
		this.rowIndex = 0;
		this.applyFilter();
	}

	private applyFilter(): void {
		const catKey = this.categories[this.catIndex] ?? "";
		const source = this.byCategory.get(catKey) ?? [];
		const query = (this.searchTerms.get(catKey) ?? "").toLowerCase().trim();

		let result = source;

		// Apply text query filter
		if (query) {
			result = result.filter(
				(m) =>
					m.name.toLowerCase().includes(query) ||
					m.id.toLowerCase().includes(query),
			);
		}

		// Apply thinking filter
		if (this.filterThinking === true) {
			result = result.filter((m) => m.reasoning);
		} else if (this.filterThinking === false) {
			result = result.filter((m) => !m.reasoning);
		}

		// Apply vision filter
		if (this.filterVision === true) {
			result = result.filter((m) => m.input.includes("image"));
		} else if (this.filterVision === false) {
			result = result.filter((m) => !m.input.includes("image"));
		}

		// Apply max token filter
		if (this.filterMaxTokens !== null) {
			result = result.filter((m) => m.contextWindow <= this.filterMaxTokens);
		}

		this.filteredRows = result;
		// Clamp row selection
		this.rowIndex = Math.min(this.rowIndex, Math.max(0, this.filteredRows.length - 1));
	}

	private switchCategory(delta: number): void {
		// Save current search term for this category before leaving
		const oldKey = this.categories[this.catIndex] ?? "";
		this.searchTerms.set(oldKey, this.searchInput.getValue());

		this.catIndex =
			(this.catIndex + delta + this.categories.length) % this.categories.length;

		// Restore search term for new category
		const newKey = this.categories[this.catIndex] ?? "";
		const saved = this.searchTerms.get(newKey) ?? "";
		this.searchInput.setValue(saved);

		this.rowIndex = 0;
		this.applyFilter();
	}

	// ── input handling ───────────────────────────────────────────────────

	handleInput(data: string): void {
		// ↑ / ↓ — navigate the list with wraparound
		if (matchesKey(data, Key.up)) {
			this.rowIndex =
				this.rowIndex === 0
					? this.filteredRows.length - 1
					: this.rowIndex - 1;
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.rowIndex =
				this.rowIndex === this.filteredRows.length - 1
					? 0
					: this.rowIndex + 1;
			return;
		}

		// Ctrl+F — toggle favorite for the selected row
		if (matchesKey(data, Key.ctrl("f"))) {
			this.toggleFavorite();
			return;
		}

		// Ctrl+H — toggle hidden for the selected row
		if (matchesKey(data, Key.ctrl("h"))) {
			this.toggleHidden();
			return;
		}

		// Ctrl+Shift+H — toggle visibility of the Hidden tab
		if (matchesKey(data, Key.ctrlShift("h"))) {
			this.toggleHiddenTab();
			return;
		}

		// Ctrl+T — toggle thinking filter (null → true → false → null)
		if (matchesKey(data, Key.ctrl("t"))) {
			this.cycleThinkingFilter();
			return;
		}

		// Ctrl+V — toggle vision filter (null → true → false → null)
		if (matchesKey(data, Key.ctrl("v"))) {
			this.cycleVisionFilter();
			return;
		}

		// Ctrl+[ — decrease max token filter (step down through common values)
		if (matchesKey(data, Key.ctrl("["))) {
			this.decreaseTokenFilter();
			return;
		}

		// Ctrl+] — increase max token filter (step up through common values)
		if (matchesKey(data, Key.ctrl("]"))) {
			this.increaseTokenFilter();
			return;
		}

		// Ctrl+Backspace — clear all filters
		if (matchesKey(data, Key.ctrl("backspace"))) {
			this.clearFilters();
			return;
		}

		// Tab / Shift+Tab — switch category
		if (matchesKey(data, Key.tab)) {
			this.switchCategory(1);
			return;
		}
		if (matchesKey(data, Key.shift("tab"))) {
			this.switchCategory(-1);
			return;
		}

		// ← at start of empty field — switch category left
		if (matchesKey(data, Key.left) && this.searchInput.getValue() === "") {
			this.switchCategory(-1);
			return;
		}
		// → at end of empty field — switch category right
		if (matchesKey(data, Key.right) && this.searchInput.getValue() === "") {
			this.switchCategory(1);
			return;
		}

		// Everything else (including ← / → when field has text) → Input
		const before = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const after = this.searchInput.getValue();

		if (before !== after) {
			// Update stored term and refilter
			const catKey = this.categories[this.catIndex] ?? "";
			this.searchTerms.set(catKey, after);
			this.rowIndex = 0;
			this.applyFilter();
		}
	}

	// ── rendering ────────────────────────────────────────────────────────

	render(width: number, theme: any): string[] {
		const lines: string[] = [];

		// ── tab bar ──────────────────────────────────────────────────────
		lines.push(this.renderTabs(width, theme));

		// ── filter bar ──────────────────────────────────────────────────
		const activeFilters = this.renderFilterStatus(theme);
		if (activeFilters) {
			lines.push(theme.fg("border", "─".repeat(width)));
			lines.push(truncateToWidth("  " + activeFilters, width));
		}

		// ── search field ─────────────────────────────────────────────────
		lines.push(theme.fg("border", "─".repeat(width)));
		const prompt = theme.fg("muted", "  Search: ");
		const promptW = visibleWidth("  Search: ");
		const inputLines = this.searchInput.render(width - promptW);
		lines.push(prompt + (inputLines[0] ?? ""));

		// ── divider ──────────────────────────────────────────────────────
		lines.push(theme.fg("border", "─".repeat(width)));

		// ── model list ───────────────────────────────────────────────────
		const MAX_VISIBLE = 10;
		const half = Math.floor(MAX_VISIBLE / 2);
		const rows = this.filteredRows;
		const start = Math.max(0, Math.min(this.rowIndex - half, rows.length - MAX_VISIBLE));
		const visible = rows.slice(start, start + MAX_VISIBLE);

		if (rows.length === 0) {
			const query = this.searchInput.getValue();
			const catKey = this.categories[this.catIndex] ?? "";
			let msg: string;
			if (query) {
				msg = `  No models match "${query}"`;
			} else if (catKey === FAVORITES_CATEGORY) {
				msg = "  No favorites yet — press Ctrl+F on any model to add";
			} else if (catKey === HIDDEN_CATEGORY) {
				msg = "  No hidden models yet — press Ctrl+H on any model to hide";
			} else {
				msg = "  No models in this category";
			}
			lines.push(theme.fg("muted", msg));
		} else {
			const catKey = this.categories[this.catIndex] ?? "";
			for (let i = 0; i < visible.length; i++) {
				const model = visible[i]!;
				const absIdx = start + i;
				const isSelected = absIdx === this.rowIndex;
				const isCurrent =
					this.opts.currentModel?.id === model.id &&
					this.opts.currentModel?.provider === model.provider;
				const isFavorite = this.favorites.has(modelKey(model));
				const isHidden = this.hidden.has(modelKey(model));
				const showProvider = catKey === FAVORITES_CATEGORY || catKey === HIDDEN_CATEGORY || catKey === ALL_CATEGORY;
				lines.push(this.renderRow(model, isSelected, isCurrent, isFavorite, isHidden, showProvider, width, theme));
			}
			if (rows.length > MAX_VISIBLE) {
				const shown = `${start + 1}–${Math.min(start + MAX_VISIBLE, rows.length)} of ${rows.length}`;
				lines.push(theme.fg("dim", "  " + shown));
			}
		}

		// ── help bar ─────────────────────────────────────────────────────
		lines.push(theme.fg("border", "─".repeat(width)));
		const filtersActive = this.filterThinking !== null || this.filterVision !== null || this.filterMaxTokens !== null;
		let help = "↑↓ nav · Tab/←→ cat · enter select · Ctrl+F fav · Ctrl+H hide · Ctrl+T think · Ctrl+V vision · Ctrl+[/] tokens";
		if (this.showHiddenTab) {
			help += " · Ctrl+Shift+H unhide-tab";
		} else {
			help += " · Ctrl+Shift+H show-tab";
		}
		if (filtersActive) {
			help += " · Ctrl+BS clear";
		}
		help += " · esc";
		lines.push(theme.fg("dim", truncateToWidth("  " + help, width)));

		return lines;
	}

	private renderTabs(width: number, theme: any): string {
		const total = this.categories.length;
		const active = this.catIndex;
		const ARROW_W = 4; // "◀ " + " ▶"
		const SEP_W = 1;   // "│"
		const availForTabs = width - ARROW_W;

		let lo = active;
		let hi = active;
		let used = visibleWidth(` ${providerLabel(this.categories[active]!)} `);

		while (true) {
			let expanded = false;
			if (hi + 1 < total) {
				const w = SEP_W + visibleWidth(` ${providerLabel(this.categories[hi + 1]!)} `);
				if (used + w <= availForTabs) { hi++; used += w; expanded = true; }
			}
			if (lo - 1 >= 0) {
				const w = SEP_W + visibleWidth(` ${providerLabel(this.categories[lo - 1]!)} `);
				if (used + w <= availForTabs) { lo--; used += w; expanded = true; }
			}
			if (!expanded) break;
		}

		const segments: string[] = [];
		for (let i = lo; i <= hi; i++) {
			const label = ` ${providerLabel(this.categories[i]!)} `;
			segments.push(
				i === active
					? theme.fg("accent", theme.bold(label))
					: theme.fg("muted", label),
			);
		}

		const tabPart = segments.join(theme.fg("dim", "│"));
		const leftPart = lo > 0 ? theme.fg("dim", "◀ ") : "  ";
		const rightPart = hi < total - 1 ? theme.fg("dim", " ▶") : "  ";

		return truncateToWidth(leftPart + tabPart + rightPart, width);
	}

	private renderRow(
		model: Model<Api>,
		isSelected: boolean,
		isCurrent: boolean,
		isFavorite: boolean,
		isHidden: boolean,
		showProvider: boolean,
		width: number,
		theme: any,
	): string {
		const prefix = isSelected ? "▶ " : "  ";
		const ctxStr = fmtCtx(model.contextWindow);
		const tags: string[] = [];
		if (model.reasoning) tags.push("thinking");
		if (model.input.includes("image")) tags.push("vision");
		const provider = showProvider ? `${providerLabel(model.provider)}  ` : "";
		const right = `${provider}${ctxStr}  ${tags.join(" ")}`;

		const favMark = isFavorite ? " ★" : "";
		const hiddenMark = isHidden ? " ◌" : "";
		const curMark = isCurrent ? " ●" : "";
		const marks = favMark + hiddenMark + curMark;
		const nameAvail = width - visibleWidth(prefix) - visibleWidth(right) - visibleWidth(marks) - 2;
		const nameTrunc = truncateToWidth(model.name, Math.max(nameAvail, 10));
		const gap = " ".repeat(
			Math.max(0, width - visibleWidth(prefix + nameTrunc + marks) - visibleWidth(right)),
		);

		if (isSelected) {
			return (
				theme.fg("accent", prefix + nameTrunc + marks) +
				gap +
				theme.fg("accent", theme.bold(right))
			);
		} else if (isCurrent) {
			return (
				theme.fg("success", prefix + nameTrunc + marks) +
				gap +
				theme.fg("muted", right)
			);
		} else {
			return (
				theme.fg("text", prefix + nameTrunc + marks) +
				gap +
				theme.fg("dim", right)
			);
		}
	}

	private renderFilterStatus(theme: any): string {
		const parts: string[] = [];

		if (this.filterThinking !== null) {
			parts.push(theme.fg(this.filterThinking ? "success" : "warning", `thinking:${this.filterThinking}" : "no"}`));
		}

		if (this.filterVision !== null) {
			parts.push(theme.fg(this.filterVision ? "success" : "warning", `vision:${this.filterVision ? "yes" : "no"}`));
		}

		if (this.filterMaxTokens !== null) {
			const tokenStr = this.filterMaxTokens >= 1_000_000
				? `${(this.filterMaxTokens / 1_000_000).toFixed(0)}M`
				: this.filterMaxTokens >= 1_000
					? `${(this.filterMaxTokens / 1_000).toFixed(0)}k`
					: String(this.filterMaxTokens);
			parts.push(theme.fg("accent", `≤${tokenStr}`));
		}

		if (parts.length === 0) return "";

		return theme.fg("muted", "Filters: ") + theme.fg("text", parts.join(" "));
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}
}

// ─── dynamic provider discovery ──────────────────────────────────────────────
//
// Instead of hand-listing models in models.json, configure a provider once
// (url + credentials + api) under `modelProviders` in pi-model-picker.json, and
// the picker scrapes its `/models` endpoint at startup and registers every
// model it finds (optionally filtered by a regex on the model id). This runs in
// the extension *factory* so discovered models are available to interactive
// startup and to `pi --list-models`.

type ModelInput = "text" | "image";
type Cost = { input: number; output: number; cacheRead: number; cacheWrite: number };

type ModelDefaults = {
	reasoning?: boolean;
	input?: ModelInput[];
	cost?: Cost;
	contextWindow?: number;
	maxTokens?: number;
};

type ProviderSpec = {
	name: string;
	baseUrl: string;
	api?: string; // default openai-completions
	apiKey?: string; // !command / $ENV / literal — same syntax as models.json
	authHeader?: boolean; // default true (Authorization: Bearer)
	headers?: Record<string, string>;
	filter?: string; // regex: model id must match to be included (default: all)
	reasoningFilter?: string; // regex: matching ids get reasoning:true
	modelsPath?: string; // default "/models"
	defaults?: ModelDefaults;
	cacheTtlSeconds?: number; // how long to reuse the cached discovery (default 12h)
	models?: unknown[]; // static model list; when present, skip /models discovery entirely
};

const ZERO_COST: Cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

// Discovery cache. Avoids re-running `apiKey` commands / the network on every
// pi startup. Stores, per provider, the resolved key and discovered models,
// refreshed only when older than the TTL (or on a cold cache). 0600 because it
// holds resolved credentials.
const DISCOVERY_CACHE_PATH = join(tmpdir(), "pi-model-picker", "discovery-cache.json");
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

type CacheEntry = { ts: number; apiKey: string; models: unknown[] };

function readCacheAll(): Record<string, CacheEntry> {
	try {
		return JSON.parse(readFileSync(DISCOVERY_CACHE_PATH, "utf8")) as Record<string, CacheEntry>;
	} catch {
		return {};
	}
}

function writeCacheEntry(name: string, entry: CacheEntry): void {
	try {
		const all = readCacheAll();
		all[name] = entry;
		mkdirSync(path.dirname(DISCOVERY_CACHE_PATH), { recursive: true, mode: 0o700 });
		writeFileSync(DISCOVERY_CACHE_PATH, JSON.stringify(all), { mode: 0o600 });
	} catch {
		// a failed cache write just means the next launch re-discovers
	}
}

// resolveConfigValue mirrors pi's config-value syntax: a leading "!" runs the
// rest as a shell command and uses stdout; "$VAR"/"${VAR}" interpolate env;
// otherwise the value is literal. Used to obtain the key for the /models fetch.
function resolveConfigValue(value: string | undefined): string | undefined {
	if (!value) return undefined;
	if (value.startsWith("!")) {
		const shell = process.env.SHELL || "/bin/sh";
		const r = spawnSync(shell, ["-c", value.slice(1)], { encoding: "utf8" });
		if (r.status !== 0) {
			throw new Error(`apiKey command failed: ${value.slice(1)}: ${(r.stderr || "").trim()}`);
		}
		return r.stdout.trim();
	}
	return value.replace(/\$\{(\w+)\}|\$(\w+)/g, (_m, a, b) => process.env[a || b] ?? "");
}

function loadSpecs(): ProviderSpec[] {
	const candidates = [
		join(process.cwd(), ".pi", "extensions", "pi-model-picker.json"),
		join(homedir(), ".pi", "agent", "extensions", "pi-model-picker.json"),
		join(process.cwd(), ".pi", "pi-model-picker.json"),
		join(homedir(), ".pi", "pi-model-picker.json"),
	];
	for (const c of candidates) {
		try {
			const cfg = JSON.parse(readFileSync(c, "utf8"));
			if (Array.isArray(cfg.modelProviders)) return cfg.modelProviders as ProviderSpec[];
		} catch {
			// keep looking
		}
	}
	return [];
}

type RawModel = {
	id?: string;
	status?: string;
	context_window?: number;
	max_input_tokens?: number;
	max_output_tokens?: number;
	max_tokens?: number;
};

async function fetchModels(spec: ProviderSpec, key: string | undefined) {
	const url = spec.baseUrl.replace(/\/+$/, "") + (spec.modelsPath ?? "/models");
	const headers: Record<string, string> = { ...(spec.headers ?? {}) };
	// The /models endpoint itself needs auth (independent of how chat requests
	// are authed — that's spec.authHeader, passed to registerProvider below).
	if (key) headers["Authorization"] = `Bearer ${key}`;

	const res = await fetch(url, { headers });
	if (!res.ok) throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
	const payload = (await res.json()) as { data?: RawModel[] };

	const idRe = spec.filter ? new RegExp(spec.filter) : null;
	const reasoningRe = spec.reasoningFilter ? new RegExp(spec.reasoningFilter) : null;
	const d = spec.defaults ?? {};

	return (payload.data ?? [])
		.filter((m) => typeof m.id === "string" && m.id.length > 0)
		.filter((m) => !m.status || m.status === "available")
		.filter((m) => !idRe || idRe.test(m.id!))
		.map((m) => ({
			id: m.id!,
			name: m.id!,
			reasoning: reasoningRe ? reasoningRe.test(m.id!) : (d.reasoning ?? false),
			input: d.input ?? ["text"],
			cost: d.cost ?? ZERO_COST,
			// Prefer real per-model limits from /models; fall back to configured defaults.
			contextWindow: m.max_input_tokens ?? m.context_window ?? d.contextWindow ?? 128000,
			maxTokens: m.max_output_tokens ?? m.max_tokens ?? d.maxTokens ?? 4096,
		}));
}

// resolveProvider returns the key + models to register, using the cache when
// fresh (no `op`, no network) and otherwise re-discovering. On a failed refresh
// it falls back to a stale cache rather than dropping the provider.
async function resolveProvider(
	spec: ProviderSpec,
): Promise<{ ok: true; apiKey: string; models: unknown[] } | { ok: false; error: string }> {
	const cached = readCacheAll()[spec.name];
	const ttlMs = (spec.cacheTtlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
	if (cached && Date.now() - cached.ts < ttlMs) {
		return { ok: true, apiKey: cached.apiKey, models: cached.models };
	}
	try {
		const key = resolveConfigValue(spec.apiKey) ?? "";
		const models = await fetchModels(spec, key);
		if (models.length === 0) throw new Error(`no models matched (filter: ${spec.filter ?? "<all>"})`);
		writeCacheEntry(spec.name, { ts: Date.now(), apiKey: key, models });
		return { ok: true, apiKey: key, models };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (cached) {
			console.error(`[model-picker] ${spec.name}: refresh failed (${msg}); using stale cache`);
			return { ok: true, apiKey: cached.apiKey, models: cached.models };
		}
		console.error(`[model-picker] ${spec.name}: ${msg}`);
		return { ok: false, error: `${spec.name}: ${msg}` };
	}
}

// Returns discovery failures (one message per provider that could not be
// registered) so the caller can surface them to the user.
async function registerDiscoveredProviders(pi: ExtensionAPI): Promise<string[]> {
	const failures: string[] = [];
	for (const spec of loadSpecs()) {
		if (!spec?.name || !spec?.baseUrl) continue;

		// Static list wins: some gateways' /models advertises models the token
		// can't actually call (and hides the ones it can), so allow listing them
		// directly and skip discovery.
		if (Array.isArray(spec.models) && spec.models.length > 0) {
			pi.registerProvider(spec.name, {
				name: spec.name,
				baseUrl: spec.baseUrl,
				api: spec.api ?? "openai-completions",
				apiKey: resolveConfigValue(spec.apiKey) ?? "",
				authHeader: spec.authHeader ?? true,
				headers: spec.headers,
				models: spec.models,
			});
			continue;
		}

		const resolved = await resolveProvider(spec);
		if (!resolved.ok) {
			failures.push(resolved.error);
			continue;
		}
		// Register with the already-resolved key (literal) so pi never re-runs the
		// `!op read` per request either — credentials are fetched only on refresh.
		pi.registerProvider(spec.name, {
			name: spec.name,
			baseUrl: spec.baseUrl,
			api: spec.api ?? "openai-completions",
			apiKey: resolved.apiKey,
			authHeader: spec.authHeader ?? true,
			headers: spec.headers,
			models: resolved.models,
		});
	}
	return failures;
}

// ─── extension ──────────────────────────────────────────────────────────────

export default async function modelPickerExtension(pi: ExtensionAPI) {
	// Discover and register configured providers before wiring up the picker, so
	// their models show up in the picker (and in `pi --list-models`).
	const failures = await registerDiscoveredProviders(pi);

	// Surface discovery failures once when the first session starts — otherwise a
	// bad apiKey / 401 just makes the provider vanish with no visible reason.
	if (failures.length > 0) {
		let warned = false;
		pi.on("session_start", (_event, ctx) => {
			if (warned) return;
			warned = true;
			for (const f of failures) {
				ctx.ui.notify(`model-picker: provider skipped — ${f}`, "warning");
			}
		});
	}

	async function openPicker(ctx: ExtensionContext) {
		// Same logic as /model: refresh from disk, then only models with auth configured
		ctx.modelRegistry.refresh();
		const allModels = ctx.modelRegistry.getAvailable();

		if (allModels.length === 0) {
			ctx.ui.notify("No models available", "warning");
			return;
		}

		const selected = await ctx.ui.custom<Model<Api> | null>((tui, theme, _kb, done) => {
			const picker = new ModelPickerComponent({
				allModels,
				currentModel: ctx.model ?? undefined,
				onSelect: (m) => done(m),
				onCancel: () => done(null),
			});

			// Give the picker focus so the embedded Input gets IME cursor
			picker.focusedState = true;

			const header = new Container();
			header.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			header.addChild(new Text(theme.fg("accent", theme.bold("  Select Model")), 0, 0));

			const footer = new DynamicBorder((s: string) => theme.fg("accent", s));

			return {
				// Implement Focusable so pi propagates focus to the Input's cursor
				focused: true,

				render(width: number): string[] {
					return [
						...header.render(width),
						...picker.render(width, theme),
						...footer.render(width),
					];
				},
				invalidate() {
					header.invalidate();
					picker.invalidate();
				},
				handleInput(data: string) {
					picker.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!selected) return;

		const success = await pi.setModel(selected);
		if (!success) {
			ctx.ui.notify(`No API key for ${selected.provider}/${selected.id}`, "error");
		} else {
			ctx.ui.notify(`Model: ${selected.name}`, "success");
		}
	}

	// /model is a reserved built-in — use /models instead
	pi.registerCommand("models", {
		description: "Select model by provider category with search (Tab/← → switch, ↑↓ navigate)",
		handler: async (_args, ctx) => {
			await openPicker(ctx);
		},
	});

	// Keyboard shortcut
	pi.registerShortcut("ctrl+shift+m", {
		description: "Open categorized model picker",
		handler: async (ctx) => {
			await openPicker(ctx);
		},
	});
}
