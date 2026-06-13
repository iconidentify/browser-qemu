/**
 * useFileTransfer - Hook for drag-and-drop file transfer to the VM
 *
 * Handles:
 * - Uploading files to the relay server
 * - Creating HFS disk images with the files
 * - Progress tracking
 * - Error handling
 */

import { useState, useCallback, useRef } from 'react';
import { defaultHttpRelayUrl } from '../DialtoneEthernet';
import { logger } from '../logger';

export type TransferStage = 'idle' | 'uploading' | 'creating' | 'complete' | 'error';

export interface TransferFile {
  name: string;
  originalName: string;
  type: string;
  creator: string;
  size: number;
  hasResourceFork: boolean;
}

export interface TransferResult {
  diskPath: string;
  diskName: string;
  size: number;
  files: TransferFile[];
}

export interface UseFileTransferOptions {
  /** Callback when transfer completes successfully */
  onComplete?: (result: TransferResult) => void;
  /** Callback when transfer fails */
  onError?: (error: string) => void;
}

export interface UseFileTransferResult {
  /** Start file transfer */
  transferFiles: (files: File[]) => Promise<void>;
  /** Current transfer stage */
  stage: TransferStage;
  /** Upload progress (0-100) */
  progress: number;
  /** Transfer result (when complete) */
  result: TransferResult | null;
  /** Error message (when error) */
  error: string | null;
  /** Reset state to idle */
  reset: () => void;
  /** Whether a transfer is in progress */
  isTransferring: boolean;
}

// Allowed file extensions for Mac transfer
const ALLOWED_EXTENSIONS = new Set([
  '.sit', '.sitx', '.hqx', '.bin', '.sea',
  '.img', '.txt', '.text', '.pdf',
  '.gif', '.jpg', '.jpeg', '.png', '.bmp',
  '.aiff', '.aif', '.wav', '.mp3',
]);

// Maximum file sizes (match server limits)
const MAX_SINGLE_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_TOTAL_SIZE = 100 * 1024 * 1024; // 100 MB

/**
 * Validate files before upload
 */
function validateFiles(files: File[]): string | null {
  if (files.length === 0) {
    return 'No files selected';
  }

  if (files.length > 10) {
    return 'Too many files (maximum 10)';
  }

  let totalSize = 0;
  for (const file of files) {
    if (file.size > MAX_SINGLE_FILE_SIZE) {
      return `File too large: ${file.name} (max 50 MB per file)`;
    }
    totalSize += file.size;
  }

  if (totalSize > MAX_TOTAL_SIZE) {
    return `Total size too large (max 100 MB)`;
  }

  // Check extensions (warn but don't block)
  for (const file of files) {
    const ext = getExtension(file.name);
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      logger.warn(`[FileTransfer] Unknown extension: ${ext} (allowing anyway)`);
    }
  }

  return null;
}

function getExtension(filename: string): string {
  const lastDot = filename.lastIndexOf('.');
  return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : '';
}

export function useFileTransfer(options: UseFileTransferOptions = {}): UseFileTransferResult {
  const { onComplete, onError } = options;
  const httpRelayUrl = defaultHttpRelayUrl();

  const [stage, setStage] = useState<TransferStage>('idle');
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<TransferResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Abort controller for cancellation
  const abortRef = useRef<AbortController | null>(null);

  const reset = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setStage('idle');
    setProgress(0);
    setResult(null);
    setError(null);
  }, []);

  const transferFiles = useCallback(async (files: File[]) => {
    // Validate files
    const validationError = validateFiles(files);
    if (validationError) {
      setStage('error');
      setError(validationError);
      onError?.(validationError);
      return;
    }

    // Start upload
    setStage('uploading');
    setProgress(0);
    setResult(null);
    setError(null);

    abortRef.current = new AbortController();

    try {
      // Create FormData with files
      const formData = new FormData();
      for (const file of files) {
        formData.append('file', file);
      }

      logger.log(`[FileTransfer] Uploading ${files.length} files to ${httpRelayUrl}/disk/transfer`);

      // Upload with progress tracking
      const xhr = new XMLHttpRequest();

      const uploadPromise = new Promise<TransferResult>((resolve, reject) => {
        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            setProgress(pct);
          }
        });

        xhr.addEventListener('load', () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const result = JSON.parse(xhr.responseText) as TransferResult;
              resolve(result);
            } catch {
              reject(new Error('Invalid server response'));
            }
          } else {
            reject(new Error(xhr.responseText || `Server error: ${xhr.status}`));
          }
        });

        xhr.addEventListener('error', () => {
          reject(new Error('Network error'));
        });

        xhr.addEventListener('abort', () => {
          reject(new Error('Upload cancelled'));
        });

        xhr.open('POST', `${httpRelayUrl}/disk/transfer`);
        xhr.send(formData);
      });

      // Handle abort
      abortRef.current.signal.addEventListener('abort', () => {
        xhr.abort();
      });

      setStage('creating');
      const transferResult = await uploadPromise;

      logger.log(`[FileTransfer] Transfer complete: ${transferResult.diskName}`);

      setStage('complete');
      setResult(transferResult);
      onComplete?.(transferResult);

    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger.error('[FileTransfer] Transfer failed:', errorMessage);

      setStage('error');
      setError(errorMessage);
      onError?.(errorMessage);
    } finally {
      abortRef.current = null;
    }
  }, [httpRelayUrl, onComplete, onError]);

  return {
    transferFiles,
    stage,
    progress,
    result,
    error,
    reset,
    isTransferring: stage === 'uploading' || stage === 'creating',
  };
}

/**
 * Check if a file is acceptable for Mac transfer
 */
export function isAcceptableFile(file: File): boolean {
  const ext = getExtension(file.name);
  return ALLOWED_EXTENSIONS.has(ext) || ext === '';
}

/**
 * Get list of acceptable file extensions for UI display
 */
export function getAcceptableExtensions(): string[] {
  return Array.from(ALLOWED_EXTENSIONS);
}
