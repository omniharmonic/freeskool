import { useEffect, type ReactNode } from 'react';
import { SchoolMark } from './SchoolMark';

/** A quiet, bounded space for identity, invitations and one-time links. */
export function FlowFrame({ title, children, description }: { title: string; children: ReactNode; description?: ReactNode }) {
  useEffect(() => { document.title = `${title} · Free School`; }, [title]);
  return <div className="app-scroll flow-scroll"><main id="main-content" tabIndex={-1} className="flow-frame safe-top safe-x">
    <a href="/" className="signin-back">← Browse classes</a>
    <div className="flow-identity"><SchoolMark /><span>Free School</span></div>
    <h1>{title}</h1>{description ? <div className="flow-description">{description}</div> : null}
    <div className="flow-body">{children}</div>
    <p className="flow-footer">A little curiosity is all you need.</p>
  </main></div>;
}
