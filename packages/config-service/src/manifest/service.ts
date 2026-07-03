/**
 * ManifestService — kitchen upstream business logic for POST manifest + GET lookup.
 */

import { normalizeDisplayNameToSlug, suggestAlternateSlug } from './slug.js';
import { type RegistryBridge, RegistrySlugTakenError } from './registry.js';
import {
  buildManifestRef,
  normalizeContractAddress,
  type ManifestStore,
} from './store.js';
import type { ManifestCreateInput, ManifestRecord } from './types.js';

export class SlugCollisionError extends Error {
  readonly code = 'slug_collision' as const;
  readonly attemptedSlug: string;
  readonly suggestedSlug: string | null;

  constructor(attemptedSlug: string, suggestedSlug: string | null) {
    super(`slug collision: ${attemptedSlug}`);
    this.name = 'SlugCollisionError';
    this.attemptedSlug = attemptedSlug;
    this.suggestedSlug = suggestedSlug;
  }
}

export class ManifestValidationError extends Error {
  readonly code = 'validation_failed' as const;
  readonly issues: string[];

  constructor(issues: string[]) {
    super(issues.join('; '));
    this.name = 'ManifestValidationError';
    this.issues = issues;
  }
}

export interface CreateManifestResult {
  record: ManifestRecord;
  created: boolean;
}

export interface ManifestServiceDeps {
  store: ManifestStore;
  registry: RegistryBridge;
}

export class ManifestService {
  constructor(private deps: ManifestServiceDeps) {}

  async createManifest(raw: ManifestCreateInput): Promise<CreateManifestResult> {
    const issues = validateCreateInput(raw);
    if (issues.length > 0) {
      throw new ManifestValidationError(issues);
    }

    const chainId = raw.chainId.trim();
    const contractAddress = normalizeContractAddress(raw.contractAddress);
    const orderId = raw.orderId.trim();
    const displayName = raw.displayName.trim();
    const source = raw.source?.trim() || 'ordering-service';

    const existingByKey = await this.deps.store.findByIdempotencyKey(chainId, contractAddress, orderId);
    if (existingByKey) {
      return { record: existingByKey, created: false };
    }

    const existingByContract = await this.deps.store.findByContract(chainId, contractAddress);
    if (existingByContract) {
      return { record: existingByContract, created: false };
    }

    const taken = await this.collectTakenSlugs();
    const baseSlug = normalizeDisplayNameToSlug(displayName);
    const worldSlug = suggestAlternateSlug(baseSlug, taken);

    if (!worldSlug) {
      throw new SlugCollisionError(baseSlug, null);
    }

    const createdAt = new Date().toISOString();
    const record: ManifestRecord = {
      manifestRef: buildManifestRef(orderId),
      worldSlug,
      chainId,
      contractAddress,
      orderId,
      displayName,
      contactEmail: raw.contactEmail.trim(),
      source,
      createdAt,
    };

    try {
      this.deps.registry.writeManifestYaml({
        worldSlug,
        displayName,
        chainId,
        contractAddress,
        orderId,
        source,
      });
    } catch (err) {
      if (err instanceof RegistrySlugTakenError) {
        throw new SlugCollisionError(worldSlug, suggestAlternateSlug(worldSlug, await this.collectTakenSlugs()));
      }
      throw err;
    }
    await this.deps.store.insert(record);

    return { record, created: true };
  }

  async lookup(chainId: string, contractAddress: string): Promise<ManifestRecord | null> {
    const chain = chainId.trim();
    const contract = normalizeContractAddress(contractAddress);
    if (!chain || !contract) return null;

    return this.deps.store.findByContract(chain, contract);
  }

  private async collectTakenSlugs(): Promise<Set<string>> {
    const taken = this.deps.registry.listExistingSlugs();
    for (const slug of await this.deps.store.listSlugs()) {
      taken.add(slug);
    }
    return taken;
  }
}

function validateCreateInput(raw: ManifestCreateInput): string[] {
  const issues: string[] = [];
  if (!raw.chainId?.trim()) issues.push('chain_id is required');
  if (!raw.contractAddress?.trim()) issues.push('contract_address is required');
  if (!raw.displayName?.trim()) issues.push('display_name is required');
  if (!raw.contactEmail?.trim()) issues.push('contact_email is required');
  if (!raw.orderId?.trim()) issues.push('order_id is required');
  if (raw.contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.contactEmail.trim())) {
    issues.push('contact_email must be a valid email');
  }
  if (raw.contractAddress && !/^0x[0-9a-fA-F]{40}$/.test(raw.contractAddress.trim())) {
    issues.push('contract_address must be a 0x-prefixed 20-byte hex address');
  }
  return issues;
}
