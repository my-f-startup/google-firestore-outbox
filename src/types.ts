import type { Firestore, Transaction } from "@google-cloud/firestore";

export interface Logger {
  debug(context: Record<string, unknown>, message?: string): void;
  info(context: Record<string, unknown>, message?: string): void;
  warn(context: Record<string, unknown>, message?: string): void;
  error(context: Record<string, unknown>, message?: string): void;
}

export type OutboxMessage = {
  messageId: string;
  type: string;
  data: unknown;
  metadata?: Record<string, unknown>;
};

export type PublishFunction = (message: OutboxMessage) => Promise<void>;

export type OutboxOptions = {
  firestore: Firestore;
  collection: string;
  types: readonly string[];
  publish: PublishFunction;
  /**
   * Minimum age of a stored message before `publishPending` picks it up, in milliseconds.
   * It must be longer than `publishTimeoutMs`, so the job does not race the publication that
   * follows the commit.
   *
   * @default 60000
   */
  minAgeMs?: number;
  /**
   * Maximum time `publishCommitted` waits for all its messages, and `publishPending` waits for
   * each message, in milliseconds. The publication is not cancelled when the time is over, so the
   * message can still be published once and be published again later.
   *
   * @default 10000
   */
  publishTimeoutMs?: number;
  /** @default 100 */
  batchSize?: number;
  /** @default Date.now */
  now?: () => number;
  logger?: Logger;
};

export type PublishResult = {
  published: number;
  failed: number;
};

export type PendingResult = PublishResult & {
  oldestAgeMs: number | null;
};

export type Outbox = {
  record: (transaction: Transaction, messages: readonly OutboxMessage[]) => void;
  publishCommitted: (messages: readonly OutboxMessage[]) => Promise<PublishResult>;
  publishPending: () => Promise<PendingResult>;
};

export type OutboxDocument = {
  messageId: string;
  type: string;
  data: unknown;
  metadata?: Record<string, unknown>;
  createdAt: number;
};
