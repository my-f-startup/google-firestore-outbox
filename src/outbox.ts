import type { Transaction } from "@google-cloud/firestore";
import { PublishTimeoutError, reviveTimestamps, withTimeout } from "./support";
import type { Outbox, OutboxDocument, OutboxMessage, OutboxOptions, PendingResult, PublishResult } from "./types";

const DEFAULT_MIN_AGE_MS = 60_000;
const DEFAULT_PUBLISH_TIMEOUT_MS = 10_000;
const DEFAULT_BATCH_SIZE = 100;

export const createFirestoreOutbox = (options: OutboxOptions): Outbox => {
  const {
    firestore,
    collection,
    publish,
    logger,
    minAgeMs = DEFAULT_MIN_AGE_MS,
    publishTimeoutMs = DEFAULT_PUBLISH_TIMEOUT_MS,
    batchSize = DEFAULT_BATCH_SIZE,
    now = Date.now,
  } = options;
  const types = new Set(options.types);

  const outboxOf = (messages: readonly OutboxMessage[]) => messages.filter((message) => types.has(message.type));

  const toDocument = (message: OutboxMessage): OutboxDocument => ({
    messageId: message.messageId,
    type: message.type,
    data: message.data,
    ...(message.metadata && { metadata: message.metadata }),
    createdAt: now(),
  });

  const toMessage = (id: string, document: OutboxDocument): OutboxMessage => ({
    messageId: document.messageId ?? id,
    type: document.type,
    data: reviveTimestamps(document.data),
    ...(document.metadata && { metadata: reviveTimestamps(document.metadata) as Record<string, unknown> }),
  });

  const logFailure = (message: OutboxMessage, error: unknown) => {
    logger?.warn(
      { err: error, messageId: message.messageId, type: message.type, timedOut: error instanceof PublishTimeoutError },
      "Failed to publish outbox message"
    );
  };

  const record = (transaction: Transaction, messages: readonly OutboxMessage[]): void => {
    for (const message of outboxOf(messages)) {
      transaction.set(firestore.collection(collection).doc(message.messageId), toDocument(message));
    }
  };

  const publishCommitted = async (messages: readonly OutboxMessage[]): Promise<PublishResult> => {
    const result: PublishResult = { published: 0, failed: 0 };
    const deadline = now() + publishTimeoutMs;

    for (const message of outboxOf(messages)) {
      try {
        const remainingMs = deadline - now();
        if (remainingMs <= 0) throw new PublishTimeoutError("No time left to publish");

        await withTimeout(() => publish(message), remainingMs);
        await firestore.collection(collection).doc(message.messageId).delete();
        result.published += 1;
      } catch (error) {
        result.failed += 1;
        logFailure(message, error);
      }
    }

    return result;
  };

  const oldestAgeMs = async (): Promise<number | null> => {
    const snapshot = await firestore.collection(collection).orderBy("createdAt", "asc").limit(1).get();
    const oldest = snapshot.docs[0]?.data() as OutboxDocument | undefined;

    return oldest ? now() - oldest.createdAt : null;
  };

  const publishPending = async (): Promise<PendingResult> => {
    const result: PublishResult = { published: 0, failed: 0 };

    const snapshot = await firestore
      .collection(collection)
      .where("createdAt", "<=", now() - minAgeMs)
      .orderBy("createdAt", "asc")
      .limit(batchSize)
      .get();

    for (const doc of snapshot.docs) {
      const message = toMessage(doc.ref.id, doc.data() as OutboxDocument);

      try {
        await withTimeout(() => publish(message), publishTimeoutMs);
        await doc.ref.delete();
        result.published += 1;
      } catch (error) {
        result.failed += 1;
        logFailure(message, error);
      }
    }

    return { ...result, oldestAgeMs: await oldestAgeMs() };
  };

  return { record, publishCommitted, publishPending };
};
