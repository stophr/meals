import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import {
  receiptSchema,
  RECEIPT_PROMPT,
  scoreConfidence,
  type ClaudeOcrConfig,
  type ExtractReceiptInput,
  type ExtractedReceipt,
  type ReceiptExtractionResult,
} from './schema.js';

// Claude-vision OCR provider (structured outputs via messages.parse). SERVER-SIDE ONLY.
async function callModel(
  client: Anthropic,
  model: string,
  input: ExtractReceiptInput,
): Promise<ExtractedReceipt> {
  const res = await client.messages.parse({
    model,
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: input.mediaType, data: input.imageBase64 },
          },
          { type: 'text', text: RECEIPT_PROMPT },
        ],
      },
    ],
    output_config: { format: zodOutputFormat(receiptSchema) },
  });
  if (!res.parsed_output) {
    throw new Error(`Receipt extraction returned no structured output (stop: ${res.stop_reason})`);
  }
  return res.parsed_output;
}

export async function extractWithClaude(
  input: ExtractReceiptInput,
  cfg: ClaudeOcrConfig,
): Promise<ReceiptExtractionResult> {
  if (!cfg.apiKey) throw new Error('ANTHROPIC_API_KEY is required for the claude OCR provider');

  const client = new Anthropic({ apiKey: cfg.apiKey });
  const model = cfg.model ?? 'claude-sonnet-5';
  const threshold = cfg.confidenceThreshold ?? 0.98;

  let receipt = await callModel(client, model, input);
  let confidence = scoreConfidence(receipt);
  let modelUsed = model;

  // Escalate once to a stronger model if the totals checksum is off.
  if (confidence < threshold && cfg.escalationModel && cfg.escalationModel !== model) {
    const escalated = await callModel(client, cfg.escalationModel, input);
    const escalatedConfidence = scoreConfidence(escalated);
    if (escalatedConfidence > confidence) {
      receipt = escalated;
      confidence = escalatedConfidence;
      modelUsed = cfg.escalationModel;
    }
  }

  return { receipt, confidence, modelUsed };
}
