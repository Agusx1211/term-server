interface TermServerLogoProps {
  class?: string;
  title?: string;
}

export function TermServerLogo({ class: className, title }: TermServerLogoProps) {
  return (
    <svg
      class={className}
      viewBox="0 0 64 64"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : "true"}
      aria-label={title}
    >
      <rect x="7" y="7" width="50" height="50" rx="10" fill="#0878bd" />
      <path d="m20 22 10 10-10 10" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />
      <path d="M34 42h11" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" />
    </svg>
  );
}
