import { useEffect, useCallback, useRef, useState, type ReactNode } from 'react';
import { SchoolMark } from './SchoolMark';
import { useRouter } from '@tanstack/react-router';
import { useMe } from '../lib/queries';
import { ApiError } from '../lib/api';

interface ScreenProps {
  title: string;
  /**
   * A small line ABOVE the large title, for the school this screen is showing. Only
   * rendered when there is something to distinguish — see `lib/school.ts#schoolHeading`.
   */
  eyebrow?: string;
  wide?: boolean;
  layout?: 'standard' | 'library' | 'detail' | 'form' | 'account' | 'reading' | 'admin';
  intro?: ReactNode;
  /** One line under the large title. Not a label — a sentence. */
  standfirst?: string;
  trailing?: ReactNode;
  /** Renders a back chevron instead of nothing in the nav bar's leading slot. */
  back?: boolean;
  /** Sits between the large title and the content, inside the scroll area. */
  beneathTitle?: ReactNode;
  children: ReactNode;
}

const COLLAPSE_AT = 28;

/**
 * iOS large-title screen: the big title lives in the scroll content and slides
 * under a frosted nav bar, which fades its own compact title in as it goes.
 */
export function Screen({ title, eyebrow, standfirst, trailing, back, beneathTitle, children, wide = false, intro, layout = 'standard' }: ScreenProps) {
  useEffect(() => { document.title = `${title} · Free School`; }, [title]);
  const [collapsed, setCollapsed] = useState(false);
  const frame = useRef<number | null>(null);
  const router = useRouter();
  // `GET /api/auth/me` 401s with nobody signed in (see `SessionGate`); that's
  // this masthead's own cue to offer the door, not a loading flash. Skipped on
  // `back` screens (sub-pages, forms, `SessionGate`'s own fallback) so the
  // action shows once, on the tabbed screens it's meant for — Calendar,
  // Skills, Requests, People — rather than doubling up wherever else a signed
  // out visitor can land.
  const { isError, error } = useMe();
  const signedOut = !back && isError && error instanceof ApiError && error.status === 401;

  const onScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
    const top = event.currentTarget.scrollTop;
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      setCollapsed(top > COLLAPSE_AT);
    });
  }, []);

  return (
    <>
      <div className="lt-wrap glass app-chrome" data-collapsed={collapsed}>
        <div className="screen-nav safe-top safe-x flex items-center gap-2">
          {back ? (
            <button
              type="button"
              onClick={() => router.history.back()}
              className="-ml-1 flex items-center gap-1 text-blue"
              aria-label="Back"
            >
              <svg width="11" height="18" viewBox="0 0 11 18" aria-hidden="true">
                <path d="M9.5 1.5 2 9l7.5 7.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
              <span className="text-caption">Back</span>
            </button>
          ) : <a href="/" className="school-brand"><SchoolMark /><span>{wide ? title : 'Free School'}</span></a>}
          <span
            className="display flex-1 truncate text-center text-[17px] transition-opacity duration-200"
            style={{ opacity: collapsed ? 1 : 0 }}
            aria-hidden={!collapsed}
          >
            {title}
          </span>
          <div className="flex items-center gap-2">
            {trailing}
            {signedOut ? <SignInAction /> : null}
          </div>
        </div>
      </div>

      <div className={`app-scroll ${wide ? 'screen-wide' : 'screen-standard'} page-${layout}`} onScroll={onScroll}>
        <div className="pad-header" />
        <main className="screen-content" id="main-content" tabIndex={-1}>
        {intro ?? <div className="page-heading safe-x">
          {eyebrow ? <p className="page-eyebrow">{eyebrow}</p> : null}
          <h1 className="lt-title text-large font-extrabold">{title}</h1>
          {standfirst ? <p className="page-standfirst">{standfirst}</p> : null}
        </div>
        }
        {beneathTitle}
        {children}
        <div className="pad-tabbar" />
        </main>
      </div>
    </>
  );
}

/**
 * The masthead's own sign-in door — the "Ask for one" masthead action on
 * Requests is the style reference (44px target, plain copy, no exclamation
 * marks). `next` carries only the pathname: the tab a visitor comes back to,
 * not their scroll position or search text, and only the paths
 * `signin-return.ts` recognizes make it past `rememberSignInReturn`.
 */
function SignInAction() {
  const next = encodeURIComponent(window.location.pathname);
  return (
    <a href={`/signin?next=${next}`} className="header-print text-blue">
      Sign in
    </a>
  );
}
