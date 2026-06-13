/**
 * FileTransferDropZone - Drag-and-drop overlay for file transfer to VM
 *
 * Wraps the emulator screen and shows a drop overlay when files are dragged.
 * Filters for Mac-compatible file types and triggers upload on drop.
 */

import { useState, useCallback, useRef, type ReactNode, type DragEvent } from 'react';
import { isAcceptableFile } from '../hooks/useFileTransfer';
import './FileTransferDropZone.css';

interface FileTransferDropZoneProps {
  /** Child components (the emulator screen) */
  children: ReactNode;
  /** Called when files are dropped */
  onFilesDropped: (files: File[]) => void;
  /** Disable the drop zone */
  disabled?: boolean;
}

export function FileTransferDropZone({
  children,
  onFilesDropped,
  disabled = false,
}: FileTransferDropZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCountRef = useRef(0);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (disabled) return;

    dragCountRef.current++;
    if (dragCountRef.current === 1) {
      // Check if dragging files
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true);
      }
    }
  }, [disabled]);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCountRef.current--;
    if (dragCountRef.current === 0) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (disabled) return;

    // Set drop effect
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'copy';
    }
  }, [disabled]);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCountRef.current = 0;
    setIsDragging(false);

    if (disabled) return;

    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length === 0) return;

    // Filter for acceptable files
    const acceptableFiles = files.filter(isAcceptableFile);

    if (acceptableFiles.length === 0) {
      // All files were filtered out - still pass them (server will handle)
      onFilesDropped(files);
    } else {
      onFilesDropped(acceptableFiles);
    }
  }, [disabled, onFilesDropped]);

  return (
    <div
      className="file-transfer-drop-zone"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}

      {/* Drop overlay */}
      {isDragging && !disabled && (
        <div className="file-transfer-overlay">
          <div className="file-transfer-overlay-content">
            <div className="file-transfer-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
            </div>
            <div className="file-transfer-text">
              <span className="file-transfer-title">Drop files to transfer</span>
              <span className="file-transfer-hint">
                .sit, .hqx, .bin, .sea and other Mac formats
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default FileTransferDropZone;
