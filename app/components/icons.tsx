// Minimal inline line icons (lucide geometry) so the landing page needs no icon dependency.
type IconProps = { size?: number; fill?: string };

function Icon({ size = 24, fill = 'none', children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const ArrowRight = (p: IconProps) => <Icon {...p}><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></Icon>;
export const ArrowDown = (p: IconProps) => <Icon {...p}><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></Icon>;
export const ArrowUpRight = (p: IconProps) => <Icon {...p}><path d="M7 7h10v10" /><path d="M7 17 17 7" /></Icon>;
export const Check = (p: IconProps) => <Icon {...p}><path d="M20 6 9 17l-5-5" /></Icon>;
export const Heart = (p: IconProps) => (
  <Icon {...p}>
    <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
  </Icon>
);
export const MessageCircle = (p: IconProps) => <Icon {...p}><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></Icon>;
export const CalendarDays = (p: IconProps) => (
  <Icon {...p}>
    <rect width="18" height="18" x="3" y="4" rx="2" />
    <path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" />
    <path d="M8 14h.01" /><path d="M12 14h.01" /><path d="M16 14h.01" />
    <path d="M8 18h.01" /><path d="M12 18h.01" /><path d="M16 18h.01" />
  </Icon>
);
export const MenuIcon = (p: IconProps) => <Icon {...p}><path d="M4 6h16" /><path d="M4 12h16" /><path d="M4 18h16" /></Icon>;
export const CloseIcon = (p: IconProps) => <Icon {...p}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></Icon>;

export function BrandMark({ inverse = false, href = '#top' }: { inverse?: boolean; href?: string }) {
  return (
    <a href={href} aria-label="muop home" className={`brand-mark${inverse ? ' inverse' : ''}`}>
      <span className="brand-symbol" aria-hidden="true"><span /><span /><span /></span>
      <span>muop</span>
    </a>
  );
}
