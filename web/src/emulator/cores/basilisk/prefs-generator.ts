/**
 * Basilisk II Prefs Generator
 *
 * Generates the prefs configuration file content for BasiliskII WASM.
 * The prefs file is a line-based format with key-value pairs.
 */

import type { EmulatorConfig } from '../types';

/**
 * Options for prefs generation.
 */
export interface PrefsOptions {
  /** ROM filename (without path) */
  romFileName: string;

  /** Disk filenames (without path) */
  diskNames: string[];

  /** Screen width */
  width: number;

  /** Screen height */
  height: number;

  /** RAM size in bytes */
  ramSize: number;

  /** Enable JIT compilation */
  jit: boolean;

  /** Enable FPU emulation */
  fpu?: boolean;

  /** Frame skip count (0 = no skip) */
  frameskip?: number;

  /** Enable sound */
  sound?: boolean;

  /** Enable CD-ROM */
  cdrom?: boolean;

  /** Enable idle waiting (improves timing) */
  idlewait?: boolean;
}

/**
 * Generate BasiliskII prefs file content.
 *
 * @param options - Configuration options
 * @returns Prefs file content as string
 */
export function generatePrefs(options: PrefsOptions): string {
  const {
    romFileName,
    diskNames,
    width,
    height,
    ramSize,
    jit,
    fpu = true,
    frameskip = 0,
    sound = true,
    cdrom = false,
    idlewait = true,
  } = options;

  const lines: string[] = [];

  // ROM configuration
  lines.push(`rom ${romFileName}`);

  // Memory configuration
  lines.push(`ramsize ${ramSize}`);

  // Screen configuration (windowed mode)
  lines.push(`screen win/${width}/${height}`);

  // Disk configurations (boot disk first)
  for (const diskName of diskNames) {
    lines.push(`disk ${diskName}`);
  }

  // Network configuration - CRITICAL: 'ether js' enables JavaScript ethernet driver
  // Without this, BasiliskII won't use workerApi.etherWrite/etherRead for IP traffic
  lines.push(`ether js`);

  // Disable ExtFS / "The Outside World" - set to non-existent path
  lines.push(`extfs /disabled`);

  // GUI and behavior settings
  lines.push(`nogui true`);
  lines.push(`idlewait ${idlewait}`);
  lines.push(`frameskip ${frameskip}`);

  // CPU settings
  lines.push(`fpu ${fpu}`);
  lines.push(`jit ${jit}`);

  // Device settings
  lines.push(`nocdrom ${!cdrom}`);
  lines.push(`nosound ${!sound}`);

  return lines.join('\n') + '\n';
}

/**
 * Generate prefs from EmulatorConfig.
 * Convenience wrapper that extracts the needed values.
 *
 * @param config - Emulator configuration
 * @param romFileName - ROM filename (extracted from path)
 * @returns Prefs file content as string
 */
export function generatePrefsFromConfig(
  config: EmulatorConfig,
  romFileName: string
): string {
  const diskNames = config.diskPaths.map(path => {
    const parts = path.split('/');
    return parts[parts.length - 1] || 'disk.img';
  });

  return generatePrefs({
    romFileName,
    diskNames,
    width: config.screenWidth,
    height: config.screenHeight,
    ramSize: config.ramSizeMB * 1024 * 1024,
    jit: config.jit,
  });
}

/**
 * Default RAM size (16 MB).
 */
export const DEFAULT_RAM_SIZE = 16 * 1024 * 1024;

/**
 * Default screen dimensions.
 */
export const DEFAULT_SCREEN = {
  width: 800,
  height: 600,
} as const;
