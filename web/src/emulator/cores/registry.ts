/**
 * Core Registry
 *
 * Manages registration and lookup of emulator cores.
 * Cores register themselves when their module is imported.
 */

import type { CoreAdapter } from './types';

/**
 * Factory function that creates a CoreAdapter.
 */
export type CoreAdapterFactory = () => CoreAdapter;

/**
 * Registry of available emulator cores.
 */
const coreRegistry = new Map<string, CoreAdapterFactory>();

/**
 * Register a core adapter factory.
 *
 * @param id - Unique identifier for the core
 * @param factory - Function that creates the adapter
 */
export function registerCore(id: string, factory: CoreAdapterFactory): void {
  if (coreRegistry.has(id)) {
    console.warn(`[CoreRegistry] Core "${id}" is already registered, overwriting.`);
  }
  coreRegistry.set(id, factory);
}

/**
 * Get a core adapter by ID.
 *
 * @param id - The core identifier
 * @returns A new instance of the core adapter
 * @throws Error if the core is not registered
 */
export function getCore(id: string): CoreAdapter {
  const factory = coreRegistry.get(id);
  if (!factory) {
    const available = Array.from(coreRegistry.keys()).join(', ') || 'none';
    throw new Error(`Unknown core: "${id}". Available cores: ${available}`);
  }
  return factory();
}

/**
 * Get all registered core IDs.
 */
export function getRegisteredCores(): string[] {
  return Array.from(coreRegistry.keys());
}

/**
 * Check if a core is registered.
 */
export function isCoreRegistered(id: string): boolean {
  return coreRegistry.has(id);
}

/**
 * Get all registered cores as adapters.
 * Useful for displaying available options in UI.
 */
export function getAllCores(): CoreAdapter[] {
  return Array.from(coreRegistry.values()).map(factory => factory());
}

/**
 * Unregister a core (mainly for testing).
 */
export function unregisterCore(id: string): boolean {
  return coreRegistry.delete(id);
}

/**
 * Clear all registered cores (mainly for testing).
 */
export function clearCoreRegistry(): void {
  coreRegistry.clear();
}
