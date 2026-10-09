export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 26 26" aria-hidden="true">
      <circle cx="13" cy="13" r="11.5" fill="none" stroke="var(--cy)" strokeWidth="1.5" />
      <path d="M13 13 L13 1.5 A11.5 11.5 0 0 1 24 10 Z" fill="var(--acc)" />
    </svg>
  );
}
