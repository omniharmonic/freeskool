import type { ReactNode } from 'react';
import { LEVEL_LABEL, type SkillLevel } from '../lib/mock';

/** Three stamped squares. Filled ones say how much practice the class assumes. */
export function LevelDots({
  level,
  className,
  inkColor,
}: {
  level: SkillLevel;
  className?: string;
  /** Set when the dots sit on a printed ink block and need a readable colour. */
  inkColor?: string;
}) {
  const color = inkColor ?? 'var(--c-ink)';
  return (
    <span className={`inline-flex items-center gap-[3px] ${className ?? ''}`} title={LEVEL_LABEL[level]}>
      <span className="sr-only">{LEVEL_LABEL[level]}</span>
      {[1, 2, 3].map((n) => (
        <span
          key={n}
          aria-hidden="true"
          className="h-[7px] w-[7px] border-[1.5px]"
          style={{ borderColor: color, background: n <= level ? color : 'transparent' }}
        />
      ))}
    </span>
  );
}

export function SkillChip({ children, ink = 'ink' }: { children: ReactNode; ink?: 'ink' | 'pink' | 'blue' }) {
  const color = ink === 'ink' ? 'var(--c-ink)' : 'var(--c-blue)';
  return (
    <span
      className="inline-flex items-center rounded-full border-[1.5px] px-2.5 py-[3px] text-[12.5px] leading-none font-medium"
      style={{ borderColor: color, color }}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  onClick,
  ink = 'pink',
  variant = 'solid',
  type = 'button',
  disabled,
  href,
  wide,
}: {
  children: ReactNode;
  onClick?: () => void;
  ink?: 'pink' | 'blue' | 'ink' | 'green' | 'amber';
  variant?: 'solid' | 'quiet';
  type?: 'button' | 'submit';
  disabled?: boolean;
  href?: string;
  wide?: boolean;
}) {
  const base = `fs-button fs-button-${variant} fs-button-${ink} ${wide ? 'fs-button-wide' : ''}`;

  if (href) {
    return (
      <a href={href} target="_self" className={base}>
        {children}
      </a>
    );
  }
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={base}>
      {children}
    </button>
  );
}

/** A filled rule, not a rounded pill: how close a request is to happening. */
export function ThresholdRule({ count, threshold }: { count: number; threshold: number }) {
  const pct = Math.min(100, Math.round((count / Math.max(1, threshold)) * 100));
  const met = count >= threshold;
  return (
    <div>
      <div className="threshold" role="img" aria-label={`${count} of ${threshold} people needed`}>
        <i style={{ width: `${pct}%`, backgroundColor: met ? 'var(--c-green)' : 'var(--c-amber)' }} />
      </div>
      <p className="mt-1.5 text-caption text-ink-soft">
        {met
          ? `${count} people in — enough to run it`
          : `${count} of ${threshold} people needed before someone teaches it`}
      </p>
    </div>
  );
}

export function SectionHeading({ children }: { children: ReactNode }) {
  return <h2 className="section-heading">{children}</h2>;
}

/**
 * A real `<input type="checkbox" switch>` where WebKit supports it — that is the
 * one control on iOS that still produces a native haptic tick. Everywhere else,
 * a stamped toggle that matches the rest of the press.
 */
const supportsNativeSwitch =
  typeof document !== 'undefined' && 'switch' in document.createElement('input');

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  if (supportsNativeSwitch) {
    return (
      <input
        type="checkbox"
        {...({ switch: '' } as unknown as React.InputHTMLAttributes<HTMLInputElement>)}
        checked={checked}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        className="h-[31px] w-[51px] shrink-0"
        style={{ accentColor: 'var(--c-green)' }}
      />
    );
  }
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className="relative h-[30px] w-[52px] shrink-0 border-[1.5px] border-ink transition-colors duration-150"
      style={{ background: checked ? 'var(--c-green)' : 'var(--c-paper-3)' }}
    >
      <span
        aria-hidden="true"
        className="absolute top-[2px] h-[22px] w-[22px] border-[1.5px] border-ink transition-[left] duration-150"
        style={{ left: checked ? '26px' : '2px', background: 'var(--c-paper-2)' }}
      />
    </button>
  );
}

/**
 * How much practice someone claims, as a word. The server stores these as the
 * raw enum (`fs_skill_claim_index.level`), and three screens now render them —
 * Me, a member's profile, and a skill page's people list.
 */
export const CLAIM_LEVEL_LABEL: Record<string, string> = {
  learning: 'Learning',
  practicing: 'Practicing',
  proficient: 'Proficient',
  teaching: 'Teaching',
};

/** Most practised first: how a profile reads down the page. */
export const CLAIM_LEVEL_ORDER = ['teaching', 'proficient', 'practicing', 'learning'] as const;

export function claimLevelLabel(level: string): string {
  return CLAIM_LEVEL_LABEL[level] ?? level;
}

/** Up to two letters from a name, for the avatar fallback. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
}

/**
 * A member's picture, or their initials. The image itself is served from
 * `/api/members/:did/avatar`, which is members-only and `no-store` — so this is
 * never a public face, only one member looking at another. `alt=""` on purpose:
 * the name is always right next to it, and a second reading of it is noise.
 */
export function MemberAvatar({ src, name, size = 48 }: { src?: string; name: string; size?: number }) {
  return (
    <span className="member-avatar" style={{ width: size, height: size, fontSize: Math.round(size / 2.6) }}>
      {src ? <img src={src} alt="" /> : <span aria-hidden="true">{initialsOf(name)}</span>}
    </span>
  );
}
