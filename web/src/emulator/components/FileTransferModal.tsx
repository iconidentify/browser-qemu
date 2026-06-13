/**
 * FileTransferModal - Progress and confirmation modal for file transfers
 *
 * Shows upload progress, disk creation status, and restart confirmation.
 */

import { memo } from 'react';
import type { TransferStage, TransferResult } from '../hooks/useFileTransfer';
import './FileTransferModal.css';

interface FileTransferModalProps {
  /** Whether modal is open */
  isOpen: boolean;
  /** Current transfer stage */
  stage: TransferStage;
  /** Upload progress (0-100) */
  progress: number;
  /** Transfer result (when complete) */
  result: TransferResult | null;
  /** Error message (when error) */
  error: string | null;
  /** Called when user clicks restart */
  onRestart: () => void;
  /** Called when user clicks close/cancel */
  onClose: () => void;
}

export const FileTransferModal = memo(function FileTransferModal({
  isOpen,
  stage,
  progress,
  result,
  error,
  onRestart,
  onClose,
}: FileTransferModalProps) {
  if (!isOpen) return null;

  const canClose = stage === 'complete' || stage === 'error';
  const showProgress = stage === 'uploading' || stage === 'creating';

  return (
    <div className="file-transfer-modal-overlay">
      <div className="file-transfer-modal">
        {/* Header */}
        <div className="file-transfer-modal-header">
          <h3>
            {stage === 'uploading' && 'Uploading Files...'}
            {stage === 'creating' && 'Creating Disk Image...'}
            {stage === 'complete' && 'Transfer Complete'}
            {stage === 'error' && 'Transfer Failed'}
          </h3>
          {canClose && (
            <button
              className="file-transfer-close-btn"
              onClick={onClose}
              aria-label="Close"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Content */}
        <div className="file-transfer-modal-content">
          {/* Progress */}
          {showProgress && (
            <div className="file-transfer-progress">
              <div className="file-transfer-progress-bar">
                <div
                  className="file-transfer-progress-fill"
                  style={{
                    width: stage === 'uploading' ? `${progress}%` : '100%',
                    animation: stage === 'creating' ? 'progress-pulse 1.5s ease-in-out infinite' : undefined,
                  }}
                />
              </div>
              <span className="file-transfer-progress-text">
                {stage === 'uploading' ? `${progress}%` : 'Processing...'}
              </span>
            </div>
          )}

          {/* Success */}
          {stage === 'complete' && result && (
            <div className="file-transfer-success">
              <div className="file-transfer-success-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div className="file-transfer-success-info">
                <p className="file-transfer-disk-name">{result.diskName}</p>
                <p className="file-transfer-disk-size">
                  {formatBytes(result.size)} - {result.files.length} file{result.files.length !== 1 ? 's' : ''}
                </p>
                {result.files.length > 0 && (
                  <ul className="file-transfer-file-list">
                    {result.files.slice(0, 5).map((file) => (
                      <li key={file.name}>
                        <span className="file-name">{file.name}</span>
                        <span className="file-type">{file.type}/{file.creator}</span>
                      </li>
                    ))}
                    {result.files.length > 5 && (
                      <li className="file-list-more">
                        +{result.files.length - 5} more
                      </li>
                    )}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {stage === 'error' && error && (
            <div className="file-transfer-error">
              <div className="file-transfer-error-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <p className="file-transfer-error-message">{error}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        {canClose && (
          <div className="file-transfer-modal-footer">
            {stage === 'complete' && (
              <>
                <button
                  className="file-transfer-btn file-transfer-btn-secondary"
                  onClick={onClose}
                >
                  Later
                </button>
                <button
                  className="file-transfer-btn file-transfer-btn-primary"
                  onClick={onRestart}
                >
                  Restart to Mount
                </button>
              </>
            )}
            {stage === 'error' && (
              <button
                className="file-transfer-btn file-transfer-btn-secondary"
                onClick={onClose}
              >
                Close
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
});

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default FileTransferModal;
