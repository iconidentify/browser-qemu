/**
 * LockLostToast - Toast notification when a disk lock is taken over
 */

import { memo, useEffect } from 'react';

interface LockLostToastProps {
  diskName: string;
  onDismiss: () => void;
  onReacquire: () => void;
}

// Lock icon SVG
const LockIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

export const LockLostToast = memo(function LockLostToast({
  diskName,
  onDismiss,
  onReacquire,
}: LockLostToastProps) {
  // Auto-dismiss after 30 seconds
  useEffect(() => {
    const timer = setTimeout(onDismiss, 30000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      className="lock-lost-toast"
      role="alert"
      aria-live="assertive"
    >
      <div className="lock-lost-toast-icon">
        <LockIcon />
      </div>
      <div className="lock-lost-toast-content">
        <div className="lock-lost-toast-title">Disk access transferred</div>
        <div className="lock-lost-toast-body">
          {diskName} is now controlled by another tab.
          This session is read-only.
        </div>
        <div className="lock-lost-toast-actions">
          <button
            className="dismiss-btn"
            onClick={onDismiss}
            type="button"
          >
            Dismiss
          </button>
          <button
            className="reacquire-btn"
            onClick={onReacquire}
            type="button"
          >
            Reacquire
          </button>
        </div>
      </div>
    </div>
  );
});

export default LockLostToast;
