import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import type { Firestore, Transaction } from "@google-cloud/firestore";
import { InMemoryFirestore } from "@emmett-community/emmett-google-firestore/testing";
import { createFirestoreOutbox } from "../src/outbox";
import type { OutboxMessage } from "../src/types";

const COLLECTION = "orders-outbox";
const MIN_AGE_MS = 1000;

const message = (messageId: string, overrides: Partial<OutboxMessage> = {}): OutboxMessage => ({
  messageId,
  type: "OrderPlaced",
  data: { orderId: messageId },
  ...overrides,
});

describe("google-firestore-outbox with the in-memory Firestore", () => {
  let firestore: InMemoryFirestore;
  let clock: number;
  let published: OutboxMessage[];
  let failFor: Set<string>;
  let hangFor: Set<string>;
  let slowFor: Map<string, number>;

  beforeEach(() => {
    firestore = new InMemoryFirestore();
    clock = 1_000_000;
    published = [];
    failFor = new Set();
    hangFor = new Set();
    slowFor = new Map();
  });

  const outbox = (overrides: Partial<Parameters<typeof createFirestoreOutbox>[0]> = {}) =>
    createFirestoreOutbox({
      firestore: firestore as unknown as Firestore,
      collection: COLLECTION,
      types: ["OrderPlaced"],
      minAgeMs: MIN_AGE_MS,
      publishTimeoutMs: 50,
      now: () => clock,
      publish: async (published_) => {
        if (hangFor.has(published_.messageId)) return new Promise<never>(() => {});
        if (failFor.has(published_.messageId)) throw new Error("publisher down");
        const delayMs = slowFor.get(published_.messageId);
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        published.push(published_);
      },
      ...overrides,
    });

  const commit = (messages: OutboxMessage[], target = outbox()) =>
    firestore.runTransaction(async (transaction) => {
      target.record(transaction as unknown as Transaction, messages);
    });

  const storedIds = async () =>
    (await firestore.collection(COLLECTION).get()).docs.map((doc) => doc.ref.id).sort();

  describe("record", () => {
    // Feature: Record messages in the transaction | Scenario: Messages of a listed type are stored with the transaction
    it("stores a document keyed by the message id for a listed type", async () => {
      await commit([message("m1")]);

      assert.deepStrictEqual(await storedIds(), ["m1"]);
    });

    // Feature: Record messages in the transaction | Scenario: Messages of a type that is not listed are not stored
    it("does not store a message of a type that is not listed", async () => {
      await commit([message("m1", { type: "OrderInformationChanged" })]);

      assert.deepStrictEqual(await storedIds(), []);
    });

    // Feature: Record messages in the transaction | Scenario: Nothing is stored when the transaction fails
    it("stores nothing when the transaction fails", async () => {
      const target = outbox();

      await assert.rejects(
        firestore.runTransaction(async (transaction) => {
          target.record(transaction as unknown as Transaction, [message("m1")]);
          throw new Error("rolled back");
        }),
        /rolled back/
      );

      assert.deepStrictEqual(await storedIds(), []);
    });

    // Feature: Keep the message identity | Scenario: The document is keyed by the message id
    it("keeps the type, data and metadata of the message", async () => {
      await commit([message("m1", { data: { total: 10 }, metadata: { actor: "user-1" } })]);

      const [doc] = (await firestore.collection(COLLECTION).get()).docs;
      assert.deepStrictEqual(doc.data(), {
        messageId: "m1",
        type: "OrderPlaced",
        data: { total: 10 },
        metadata: { actor: "user-1" },
        createdAt: clock,
      });
    });
  });

  describe("publishCommitted", () => {
    // Feature: Publish messages after the commit | Scenario: A published message is removed from the outbox
    it("publishes the messages and removes them from the outbox", async () => {
      const target = outbox();
      await commit([message("m1"), message("m2")], target);

      const result = await target.publishCommitted([message("m1"), message("m2")]);

      assert.deepStrictEqual(result, { published: 2, failed: 0 });
      assert.deepStrictEqual(
        published.map((item) => item.messageId),
        ["m1", "m2"]
      );
      assert.deepStrictEqual(await storedIds(), []);
    });

    // Feature: Publish messages after the commit | Scenario: A failed publication leaves the message in the outbox
    it("leaves the message in the outbox and reports the failure when the publication fails", async () => {
      const target = outbox();
      failFor.add("m1");
      await commit([message("m1"), message("m2")], target);

      const result = await target.publishCommitted([message("m1"), message("m2")]);

      assert.deepStrictEqual(result, { published: 1, failed: 1 });
      assert.deepStrictEqual(await storedIds(), ["m1"]);
    });

    // Feature: Publish messages after the commit | Scenario: The wait is bounded
    it("returns when the time is over and leaves the message in the outbox", async () => {
      const target = outbox({ publishTimeoutMs: 30, now: undefined });
      hangFor.add("m1");
      await commit([message("m1")], target);

      const started = Date.now();
      const result = await target.publishCommitted([message("m1")]);

      assert.deepStrictEqual(result, { published: 0, failed: 1 });
      assert.ok(Date.now() - started < 1000);
      assert.deepStrictEqual(await storedIds(), ["m1"]);
    });

    // Feature: Publish messages after the commit | Scenario: A publisher that answers after the time is over
    it("keeps the message and publishes it again, with the same id, when the publisher answers late", async () => {
      const target = outbox({ publishTimeoutMs: 20 });
      slowFor.set("m1", 60);
      await commit([message("m1")], target);

      const first = await target.publishCommitted([message("m1")]);
      await new Promise((resolve) => setTimeout(resolve, 100));
      slowFor.clear();
      clock += MIN_AGE_MS + 1;
      const second = await target.publishPending();

      assert.deepStrictEqual(first, { published: 0, failed: 1 });
      assert.deepStrictEqual(second.published, 1);
      assert.deepStrictEqual(
        published.map((item) => item.messageId),
        ["m1", "m1"]
      );
      assert.deepStrictEqual(await storedIds(), []);
    });

    // Feature: Publish messages after the commit | Scenario: Messages of a type that is not listed are not published
    it("does not publish a message of a type that is not listed", async () => {
      const result = await outbox().publishCommitted([message("m1", { type: "OrderInformationChanged" })]);

      assert.deepStrictEqual(result, { published: 0, failed: 0 });
      assert.deepStrictEqual(published, []);
    });
  });

  describe("publishPending", () => {
    // Feature: Recover unpublished messages | Scenario: A stored message that is old enough is published and removed
    it("publishes a message that is older than the minimum age and removes it", async () => {
      const target = outbox();
      await commit([message("m1")], target);
      clock += MIN_AGE_MS + 1;

      const result = await target.publishPending();

      assert.deepStrictEqual(result, { published: 1, failed: 0, oldestAgeMs: null });
      assert.deepStrictEqual(
        published.map((item) => item.messageId),
        ["m1"]
      );
      assert.deepStrictEqual(await storedIds(), []);
    });

    // Feature: Recover unpublished messages | Scenario: A recent message is left for the publication that follows the commit
    it("leaves a recent message alone", async () => {
      const target = outbox();
      await commit([message("m1")], target);
      clock += MIN_AGE_MS - 1;

      const result = await target.publishPending();

      assert.deepStrictEqual(result, { published: 0, failed: 0, oldestAgeMs: MIN_AGE_MS - 1 });
      assert.deepStrictEqual(published, []);
      assert.deepStrictEqual(await storedIds(), ["m1"]);
    });

    // Feature: Recover unpublished messages | Scenario: A failed message does not block the others
    it("keeps going after a message that fails", async () => {
      const target = outbox();
      failFor.add("m1");
      await commit([message("m1")], target);
      clock += 1;
      await commit([message("m2")], target);
      clock += MIN_AGE_MS + 1;

      const result = await target.publishPending();

      assert.deepStrictEqual(result, { published: 1, failed: 1, oldestAgeMs: MIN_AGE_MS + 2 });
      assert.deepStrictEqual(
        published.map((item) => item.messageId),
        ["m2"]
      );
      assert.deepStrictEqual(await storedIds(), ["m1"]);
    });

    // Feature: Recover unpublished messages | Scenario: The age of the oldest stored message is reported
    it("reports the age of the oldest message that is still stored", async () => {
      const target = outbox();
      failFor.add("m1");
      await commit([message("m1")], target);
      clock += 500;
      await commit([message("m2")], target);
      clock += MIN_AGE_MS;

      const result = await target.publishPending();

      assert.strictEqual(result.oldestAgeMs, MIN_AGE_MS + 500);
    });

    // Feature: Recover unpublished messages | Scenario: The batch is bounded
    it("publishes only the oldest messages up to the batch size", async () => {
      const target = outbox({ batchSize: 2 });
      for (const id of ["m1", "m2", "m3"]) {
        await commit([message(id)], target);
        clock += 1;
      }
      clock += MIN_AGE_MS;

      const result = await target.publishPending();

      assert.deepStrictEqual(result, { published: 2, failed: 0, oldestAgeMs: MIN_AGE_MS + 1 });
      assert.deepStrictEqual(
        published.map((item) => item.messageId),
        ["m1", "m2"]
      );
      assert.deepStrictEqual(await storedIds(), ["m3"]);
    });

    // Feature: Keep the message identity | Scenario: A message recovered later has the same id as the one published after the commit
    it("publishes the same message that was recorded", async () => {
      const target = outbox();
      const recorded = message("m1", { data: { total: 10 }, metadata: { actor: "user-1" } });
      await commit([recorded], target);
      clock += MIN_AGE_MS + 1;

      await target.publishPending();

      assert.deepStrictEqual(published, [recorded]);
    });
  });
});
