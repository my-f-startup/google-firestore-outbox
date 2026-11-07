import { Timestamp } from "@google-cloud/firestore";

export class PublishTimeoutError extends Error {}

export const withTimeout = async <T>(operation: () => Promise<T>, timeoutMs: number): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new PublishTimeoutError(`Publication timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
        timeoutHandle.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }
};

export const reviveTimestamps = (value: unknown): unknown => {
  if (value instanceof Timestamp) return value.toDate();
  if (Array.isArray(value)) return value.map(reviveTimestamps);
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, reviveTimestamps(entry)])
    );
  }
  return value;
};
