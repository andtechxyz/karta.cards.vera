import { useEffect } from 'react';

// Right-edge slide-over panel.  Replaces inline row expansion — the source
// row stays highlighted in the table while the drawer shows its detail.
// ESC closes; click on the scrim closes; focus is not trapped because the
// admin is already behind a Cognito gate and this isn't a modal dialog.

export function Drawer({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <>
      <div className="vera-drawer-scrim" onClick={onClose} />
      <aside className="vera-drawer" role="dialog" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="vera-drawer-head">
          <h3>{title}</h3>
          <button
            className="vera-drawer-close"
            onClick={onClose}
            aria-label="Close drawer"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
        <div className="vera-drawer-body">{children}</div>
      </aside>
    </>
  );
}
