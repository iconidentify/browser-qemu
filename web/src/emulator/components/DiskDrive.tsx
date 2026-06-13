/**
 * DiskDrive - Traditional 3.5" floppy disk drive slot
 *
 * A classic horizontal floppy drive slot with activity LED.
 * Shows disk name label below the slot.
 */

import { useState, useCallback, useRef } from 'react';
import './DiskDrive.css';

interface DiskDriveProps {
  /** Whether a disk is currently loaded */
  diskLoaded?: boolean;
  /** Called when user drops a disk image file */
  onDiskDrop?: (file: File) => void;
  /** Whether the drive is actively reading/writing */
  isActive?: boolean;
}

export function DiskDrive({
  diskLoaded = true,
  onDiskDrop,
  isActive = false,
}: DiskDriveProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length > 0 && onDiskDrop) {
      const file = files[0];
      // Check for disk image extensions
      const validExtensions = ['.dsk', '.img', '.iso', '.image', '.hfv'];
      const hasValidExt = validExtensions.some(ext =>
        file.name.toLowerCase().endsWith(ext)
      );
      if (hasValidExt || file.type === 'application/octet-stream') {
        onDiskDrop(file);
      }
    }
  }, [onDiskDrop]);

  const handleClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0 && onDiskDrop) {
      onDiskDrop(files[0]);
    }
  }, [onDiskDrop]);

  return (
    <div
      className={`disk-drive ${isDragOver ? 'drag-over' : ''} ${isActive ? 'active' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={handleClick}
      title={diskLoaded ? 'Floppy Drive' : 'Drop disk image here'}
    >
      {/* Drive slot */}
      <div className="drive-slot">
        <div className="drive-slot-inner" />
        {/* Eject hole */}
        <div className="drive-eject-hole" />
      </div>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".dsk,.img,.iso,.image,.hfv"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />
    </div>
  );
}
