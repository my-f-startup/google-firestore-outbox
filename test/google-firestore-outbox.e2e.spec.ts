import assert from "node:assert";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { Firestore } from "@google-cloud/firestore";
import { GenericContainer, Wait } from "testcontainers";
import { createFirestoreOutbox } from "../src/outbox";
import type { OutboxMessage } from "../src/types";

const projectId = "demo-project";
const COLLECTION = "orders-outbox";
const MIN_AGE_MS = 1000;

let emulator: import("testcontainers").StartedTestContainer | null = null;
let emulatorHost = "";
let emulatorPort = 0;
let firestore: Firestore;

const emulatorUrl = () => `http://${emulatorHost}:${emulatorPort}`;

const startEmulator = async () => {
  const container = await new GenericContainer("myfstartup/firebase-emulator-suite:15")
    .withPlatform("linux/amd64")
    .withExposedPorts(4000, 8080)
    .withBindMounts([
      {
        source: path.join(process.cwd(), "test", "firebase", "firebase.json"),
        target: "/app/firebase.json",
        mode: "ro" as const,
      },
      {
        source: path.join(process.cwd(), "test", "firebase", ".firebaserc"),
        target: "/app/.firebaserc",
        mode: "ro" as const,
      },
    ])
    .withEnvironment({ PROJECT_ID: projectId })
    .withWaitStrategy(Wait.forHealthCheck())
    .start();

  emulatorHost = container.getHost();
  emulatorPort = container.getMappedPort(8080);

  return container;
};

const resetEmulator = async () => {
  const response = await fetch(
    `${emulatorUrl()}/emulator/v1/projects/${projectId}/databases/(default)/documents`,
    { method: "DELETE" }
  );

  if (!response.ok) {
    throw new Error(`Failed to reset Firestore emulator: ${response.status} ${response.statusText}`);
  }
};

describe("google-firestore-outbox with the Firestore emulator", () => {
  let clock: number;
  let published: OutboxMessage[];

  before(async () => {
    emulator = await startEmulator();

    firestore = new Firestore({
      projectId,
      host: `${emulatorHost}:${emulatorPort}`,
      ssl: false,
      customHeaders: { Authorization: "Bearer owner" },
    });
  });

  after(async () => {
    await firestore.terminate();
    await emulator?.stop();
  });

  beforeEach(async () => {
    await resetEmulator();
    clock = Date.now();
    published = [];
  });

  const outbox = () =>
    createFirestoreOutbox({
      firestore,
      collection: COLLECTION,
      types: ["OrderPlaced"],
      minAgeMs: MIN_AGE_MS,
      now: () => clock,
      publish: async (message) => {
        published.push(message);
      },
    });

  const storedIds = async () => (await firestore.collection(COLLECTION).get()).docs.map((doc) => doc.id).sort();

  // Feature: Record messages in the transaction | Scenario: Messages of a listed type are stored with the transaction
  it("commits the message together with the data of the transaction", async () => {
    const target = outbox();

    await firestore.runTransaction(async (transaction) => {
      transaction.set(firestore.collection("orders").doc("order-1"), { status: "placed" });
      target.record(transaction, [{ messageId: "m1", type: "OrderPlaced", data: { orderId: "order-1" } }]);
    });

    assert.strictEqual((await firestore.collection("orders").doc("order-1").get()).exists, true);
    assert.deepStrictEqual(await storedIds(), ["m1"]);
  });

  // Feature: Record messages in the transaction | Scenario: Nothing is stored when the transaction fails
  it("stores neither the data nor the message when the transaction fails", async () => {
    const target = outbox();

    await assert.rejects(
      firestore.runTransaction(async (transaction) => {
        transaction.set(firestore.collection("orders").doc("order-1"), { status: "placed" });
        target.record(transaction, [{ messageId: "m1", type: "OrderPlaced", data: {} }]);
        throw new Error("rolled back");
      }),
      /rolled back/
    );

    assert.strictEqual((await firestore.collection("orders").doc("order-1").get()).exists, false);
    assert.deepStrictEqual(await storedIds(), []);
  });

  // Feature: Record messages in the transaction | Scenario: Only the attempt that commits is kept when the transaction is retried
  it("keeps one document for each committed message when Firestore retries transactions", async () => {
    const target = outbox();
    const counter = firestore.collection("counters").doc("orders");
    await counter.set({ value: 0 });
    let attempts = 0;

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        firestore.runTransaction(async (transaction) => {
          attempts += 1;
          const current = (await transaction.get(counter)).data()?.value as number;
          transaction.set(counter, { value: current + 1 });
          target.record(transaction, [{ messageId: randomUUID(), type: "OrderPlaced", data: {} }]);
        })
      )
    );

    const committed = results.filter((result) => result.status === "fulfilled").length;
    assert.ok(attempts > committed, "the test needs at least one retried transaction");
    assert.strictEqual((await counter.get()).data()?.value, committed);
    assert.strictEqual((await storedIds()).length, committed);
  });

  // Feature: Publish messages after the commit | Scenario: A published message is removed from the outbox
  it("publishes the committed message and deletes its document", async () => {
    const target = outbox();
    const recorded: OutboxMessage = { messageId: "m1", type: "OrderPlaced", data: { orderId: "order-1" } };
    await firestore.runTransaction(async (transaction) => target.record(transaction, [recorded]));

    const result = await target.publishCommitted([recorded]);

    assert.deepStrictEqual(result, { published: 1, failed: 0 });
    assert.deepStrictEqual(published, [recorded]);
    assert.deepStrictEqual(await storedIds(), []);
  });

  // Feature: Keep the message identity | Scenario: Dates in the data come back as dates
  it("publishes a recovered message with its dates as Date objects", async () => {
    const target = outbox();
    const at = new Date("2026-11-07T10:00:00.000Z");
    const recorded: OutboxMessage = {
      messageId: "m1",
      type: "OrderPlaced",
      data: { placedAt: at, items: [{ shippedAt: at }] },
      metadata: { actor: "user-1" },
    };
    await firestore.runTransaction(async (transaction) => target.record(transaction, [recorded]));
    clock += MIN_AGE_MS + 1;

    const result = await target.publishPending();

    assert.deepStrictEqual(result, { published: 1, failed: 0, oldestAgeMs: null });
    assert.deepStrictEqual(published, [recorded]);
    assert.deepStrictEqual(await storedIds(), []);
  });

  // Feature: Recover unpublished messages | Scenario: A recent message is left for the publication that follows the commit
  it("leaves a recent message alone", async () => {
    const target = outbox();
    await firestore.runTransaction(async (transaction) =>
      target.record(transaction, [{ messageId: "m1", type: "OrderPlaced", data: {} }])
    );

    const result = await target.publishPending();

    assert.strictEqual(result.published, 0);
    assert.strictEqual(typeof result.oldestAgeMs, "number");
    assert.deepStrictEqual(await storedIds(), ["m1"]);
  });
});
