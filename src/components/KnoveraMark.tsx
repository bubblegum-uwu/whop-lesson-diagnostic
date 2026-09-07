/**
 * Phase 4A visual-polish pass — the Knovera mark: three connected nodes
 * forming an abstract, minimal knowledge-network glyph (deliberately not a
 * literal "K" or a complex logo system). Renders in `currentColor` so it
 * picks up `--kv-accent` wherever it's placed (see index.css's `.kv-mark`).
 */
export function KnoveraMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path d="M6 18L12 6L18 18" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" opacity="0.55" />
      <circle cx="12" cy="6" r="2.4" fill="currentColor" />
      <circle cx="6" cy="18" r="2" fill="currentColor" opacity="0.7" />
      <circle cx="18" cy="18" r="2" fill="currentColor" opacity="0.7" />
    </svg>
  );
}
