import { lazy, Suspense, type ComponentType } from 'react';

// The 3D corridor screen is owned by the world/3D layer. If it ships
// src/components/screens/CorridorScreen.tsx (named export `CorridorScreen`
// or a default export), it is routed automatically; until then "Enter the
// hospital" falls back to the case library.
const modules = import.meta.glob('./screens/CorridorScreen.tsx');
const loader = modules['./screens/CorridorScreen.tsx'];

export const HAS_CORRIDOR = Boolean(loader);

const Lazy = loader
  ? lazy(async () => {
      const m = (await loader()) as { CorridorScreen?: ComponentType; default?: ComponentType };
      const C = m.CorridorScreen ?? m.default;
      if (!C) throw new Error('CorridorScreen.tsx has no CorridorScreen or default export.');
      return { default: C };
    })
  : null;

export function CorridorRoute({ fallback }: { fallback: JSX.Element }) {
  if (!Lazy) return fallback;
  return (
    <Suspense fallback={<div className="route-loading">Opening the hospital…</div>}>
      <Lazy />
    </Suspense>
  );
}
