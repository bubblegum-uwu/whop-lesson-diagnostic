/**
 * Phase 4A visual-polish pass — small monochrome glyphs for the Sources
 * page's provider cards. Simple geometric marks (not brand logos) so no
 * new icon-library dependency is needed; render in `currentColor`.
 */
interface IconProps {
  className?: string;
}

export function WhopIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="4" y="4" width="16" height="16" rx="4" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9 15V9L12 12L15 9V15" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function YouTubeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <rect x="3.5" y="6" width="17" height="12" rx="3.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M10.5 9.5L15 12L10.5 14.5V9.5Z" fill="currentColor" />
    </svg>
  );
}

export function DiscordIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <path
        d="M7 8.5C9.5 7.2 14.5 7.2 17 8.5C18.4 11 18.6 14 17.5 16C16 17.2 15 17.5 15 17.5L14.3 16C14.3 16 15 15.7 15.6 15.2C14.1 15.9 9.9 15.9 8.4 15.2C9 15.7 9.7 16 9.7 16L9 17.5C9 17.5 8 17.2 6.5 16C5.4 14 5.6 11 7 8.5Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <circle cx="9.5" cy="12" r="1" fill="currentColor" />
      <circle cx="14.5" cy="12" r="1" fill="currentColor" />
    </svg>
  );
}
