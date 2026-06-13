/**
 * CreateDiskForm - Form for creating new empty disk images
 *
 * Features:
 * - Name input with .dsk extension validation
 * - Size presets (100MB, 500MB, 1GB, 2GB)
 * - Custom size input with min/max validation
 * - Loading state during creation
 * - Error display
 */

import { useState, useCallback, type FormEvent } from 'react';
import './CreateDiskForm.css';

interface CreateDiskFormProps {
  onSubmit: (name: string, sizeBytes: number) => Promise<void>;
  isCreating: boolean;
}

// Size presets in bytes
const SIZE_PRESETS = [
  { label: '100 MB', bytes: 100 * 1024 * 1024 },
  { label: '500 MB', bytes: 500 * 1024 * 1024 },
  { label: '1 GB', bytes: 1024 * 1024 * 1024 },
  { label: '2 GB', bytes: 2 * 1024 * 1024 * 1024 },
];

const MIN_SIZE_MB = 10;
const MAX_SIZE_MB = 2048; // 2 GB

export function CreateDiskForm({ onSubmit, isCreating }: CreateDiskFormProps) {
  const [name, setName] = useState('');
  const [sizeMB, setSizeMB] = useState(100);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const validateName = useCallback((value: string): string | null => {
    if (!value.trim()) {
      return 'Name is required';
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
      return 'Name can only contain letters, numbers, hyphens, and underscores';
    }
    if (value.length > 50) {
      return 'Name must be 50 characters or less';
    }
    return null;
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError(null);
      setSuccess(false);

      // Validate name
      const nameError = validateName(name);
      if (nameError) {
        setError(nameError);
        return;
      }

      // Validate size
      if (sizeMB < MIN_SIZE_MB || sizeMB > MAX_SIZE_MB) {
        setError(`Size must be between ${MIN_SIZE_MB} MB and ${MAX_SIZE_MB} MB`);
        return;
      }

      try {
        const fullName = name.endsWith('.dsk') ? name : `${name}.dsk`;
        await onSubmit(fullName, sizeMB * 1024 * 1024);
        setSuccess(true);
        setName('');
        setSizeMB(100);
        // Clear success after a few seconds
        setTimeout(() => setSuccess(false), 3000);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create disk');
      }
    },
    [name, sizeMB, onSubmit, validateName]
  );

  const handlePresetClick = useCallback((bytes: number) => {
    setSizeMB(Math.round(bytes / (1024 * 1024)));
  }, []);

  return (
    <form className="create-disk-form" onSubmit={handleSubmit}>
      <div className="form-field">
        <label htmlFor="disk-name">Disk Name</label>
        <div className="input-with-suffix">
          <input
            type="text"
            id="disk-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-data-disk"
            disabled={isCreating}
            autoComplete="off"
          />
          <span className="input-suffix">.dsk</span>
        </div>
      </div>

      <div className="form-field">
        <label>Size</label>
        <div className="size-presets">
          {SIZE_PRESETS.map((preset) => (
            <button
              key={preset.bytes}
              type="button"
              className={`preset-btn ${
                sizeMB === Math.round(preset.bytes / (1024 * 1024)) ? 'active' : ''
              }`}
              onClick={() => handlePresetClick(preset.bytes)}
              disabled={isCreating}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="custom-size">
          <input
            type="number"
            value={sizeMB}
            onChange={(e) => setSizeMB(parseInt(e.target.value) || 0)}
            min={MIN_SIZE_MB}
            max={MAX_SIZE_MB}
            disabled={isCreating}
          />
          <span className="input-suffix">MB</span>
        </div>
        <span className="size-hint">
          {MIN_SIZE_MB} MB - {MAX_SIZE_MB / 1024} GB
        </span>
      </div>

      {error && <div className="form-error">{error}</div>}
      {success && <div className="form-success">Disk created successfully!</div>}

      <button
        type="submit"
        className="create-btn"
        disabled={isCreating || !name.trim()}
      >
        {isCreating ? 'Creating...' : 'Create Disk'}
      </button>
    </form>
  );
}
