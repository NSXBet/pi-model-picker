# Changelog

## 1.1.0 — 2026-08-27

OMP (oh-my-pi) compatibility.

- Storage and config follow the running agent: `getAgentDir()` / `CONFIG_DIR_NAME`
  resolve to `~/.pi/agent` under pi and `~/.omp/agent` under omp, so favorites,
  hidden models, and provider config are per-runtime.
- `package.json` declares an `omp` manifest so `omp plugin link` loads the same
  entrypoint; omp's legacy shim maps the `@earendil-works/*` imports.
- OMP ships builtin `/models` and `/providers` that shadow same-named extension
  commands, so under omp the picker registers `/pick-model` and `/pick-providers`.
- Settings-backed favorites (`enabledModels`) degrade gracefully: omp's
  SettingsManager facade lacks get/setEnabledModels, so favorites.json remains
  the source of truth there.

## 1.0.0 — 2026-02-25

Initial release.

- Categorized model picker grouped by provider
- Tab / ← → to switch categories
- Per-category search field (preserves query when switching categories)
- ↑ / ↓ navigation with wraparound
- Active model highlighted with ● marker
- Model metadata: context window size, `thinking` and `vision` tags
- `/models` command and `Ctrl+Shift+M` shortcut
- Uses same data source as built-in `/model` (`modelRegistry.refresh()` + `getAvailable()`)
