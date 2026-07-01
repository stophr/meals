// Public OCR entrypoint: dispatch to the configured provider. Adding a provider means adding
// one file under ./ and a case here — the schema/prompt/confidence stay shared.
import { extractWithClaude } from './claude.js';
import { extractWithLocal } from './local.js';
import type { ExtractReceiptInput, ReceiptExtractionResult } from './schema.js';

export * from './schema.js';

export async function extractReceipt(input: ExtractReceiptInput): Promise<ReceiptExtractionResult> {
  switch (input.provider) {
    case 'local':
      if (!input.local) throw new Error('local OCR config missing');
      return extractWithLocal(input, input.local);
    case 'claude':
      if (!input.claude) throw new Error('claude OCR config missing');
      return extractWithClaude(input, input.claude);
    default:
      throw new Error(`Unknown OCR provider: ${String(input.provider)}`);
  }
}
