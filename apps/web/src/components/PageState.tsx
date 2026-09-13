import type { ReactNode } from 'react';

/** Loading, empty and recovery states share a readable shape, never an empty page. */
export function PageState({ title, children, action, busy = false, error = false }: {
  title: string; children?: ReactNode; action?: ReactNode; busy?: boolean; error?: boolean;
}) {
  return <div className={`page-state ${error ? 'page-state-error' : ''}`} role={error ? 'alert' : 'status'} aria-busy={busy}>
    <span className="state-symbol" aria-hidden="true">{busy ? '◌' : error ? '!' : '✳'}</span>
    <div><h2>{title}</h2>{children ? <div className="state-description">{children}</div> : null}{action ? <div className="state-action">{action}</div> : null}</div>
  </div>;
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <PageState title={label} busy><div className="loading-lines" aria-hidden="true"><i /><i /><i /></div></PageState>;
}
