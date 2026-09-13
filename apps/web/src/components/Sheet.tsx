import { useEffect, useRef, type ReactNode } from 'react';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Hides the visible heading but keeps it for assistive tech. */
  hideTitle?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  panelClassName?: string;
}

/**
 * Bottom sheet on `<dialog>`.
 *
 * iOS has no `closedby` and no `CloseWatcher`, and background scroll-lock behind
 * a modal is not automatic — so dismissal and the lock are both manual here.
 */
export function Sheet({ open, onClose, title, hideTitle, children, footer, panelClassName = '' }: SheetProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Manual scroll lock: the app shell's scroller keeps scrolling behind a modal
  // dialog otherwise, and rubber-band bleeds through on iOS.
  useEffect(() => {
    if (!open) return;
    const scroller = document.querySelector<HTMLElement>('.app-scroll');
    if (!scroller) return;
    const previous = scroller.style.overflowY;
    scroller.style.overflowY = 'hidden';
    return () => {
      scroller.style.overflowY = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault(); // Esc / system back: close through React state
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose(); // tap outside the panel
      }}
    >
      <div className={`sheet-panel ${panelClassName}`}>
        <div className="sheet-handle flex justify-center pt-2.5 pb-1">
          <div className="grabber" />
        </div>
        <div className="sheet-heading flex items-start gap-3 px-5 pt-1">
          <h2 className={hideTitle ? 'sr-only' : 'flex-1 text-title'}>{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="sheet-close shrink-0 text-ink-soft"
            aria-label="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="sheet-body min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-4">{children}</div>
        {footer ? <div className="sheet-footer border-t border-rule px-5 pt-3">{footer}</div> : null}
      </div>
    </dialog>
  );
}
