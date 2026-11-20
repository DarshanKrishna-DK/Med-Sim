// Legacy type kept so `game/types.ts` and `game/store.ts` (Tweaks.palette)
// keep compiling. The MedSim UI ignores palettes; theming lives in
// tokens.css (light/dark via [data-theme] + prefers-color-scheme).
export type PaletteName = 'sunshine' | 'candy' | 'forest';
