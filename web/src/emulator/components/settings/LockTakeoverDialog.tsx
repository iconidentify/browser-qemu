/**
 * LockTakeoverDialog - Confirmation dialog for taking over a locked disk
 */

import { memo, useCallback, useEffect } from 'react';
import type { DiskLockInfo } from '../../disk/DiskLockManager';

interface LockTakeoverDialogProps {
  diskName: string;
  lockInfo: DiskLockInfo;
  onConfirm: () => void;
  onCancel: () => void;
}

export const LockTakeoverDialog = memo(function LockTakeoverDialog({
  diskName,
  lockInfo,
  onConfirm,
  onCancel,
}: LockTakeoverDialogProps) {
  // Handle escape key
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    },
    [onCancel]
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  // Format time ago
  const formatTimeAgo = (isoString: string): string => {
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return 'just now';
    if (diffMins === 1) return '1 minute ago';
    if (diffMins < 60) return `${diffMins} minutes ago`;

    const diffHours = Math.floor(diffMins / 60);
    if (diffHours === 1) return '1 hour ago';
    return `${diffHours} hours ago`;
  };

  return (
    <div className="lock-dialog-overlay" onClick={onCancel}>
      <div
        className="lock-dialog"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="lock-dialog-title"
      >
        <h3 id="lock-dialog-title">Take Over Disk Access</h3>

        <div className="lock-dialog-warning">
          <p>
            <strong>{diskName}</strong> is currently in use by another tab.
          </p>
          <p>Taking over will:</p>
          <ul>
            <li>Stop the emulator in the other tab</li>
            <li>Any unsaved changes in that tab may be lost</li>
          </ul>
        </div>

        <div style={{ fontSize: '0.75rem', color: 'var(--text-dim)' }}>
          Opened {formatTimeAgo(lockInfo.acquiredAt)}
        </div>

        <div className="lock-dialog-actions">
          <button
            className="cancel-btn"
            onClick={onCancel}
            type="button"
            autoFocus
          >
            Cancel
          </button>
          <button className="takeover-btn" onClick={onConfirm} type="button">
            Take Over
          </button>
        </div>
      </div>
    </div>
  );
});

export default LockTakeoverDialog;
