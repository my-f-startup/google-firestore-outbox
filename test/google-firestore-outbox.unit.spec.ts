import assert from "node:assert";
import { describe, it } from "node:test";
import { Timestamp } from "@google-cloud/firestore";
import { PublishTimeoutError, reviveTimestamps, withTimeout } from "../src/support";

describe("withTimeout", () => {
  it("returns the result of an operation that finishes in time", async () => {
    const result = await withTimeout(async () => "done", 1000);

    assert.strictEqual(result, "done");
  });

  it("rejects when the operation does not finish in time", async () => {
    const never = () => new Promise<never>(() => {});

    await assert.rejects(withTimeout(never, 20), PublishTimeoutError);
  });

  it("rejects with the error of the operation when it fails first", async () => {
    const failure = new Error("publisher down");

    await assert.rejects(
      withTimeout(async () => {
        throw failure;
      }, 1000),
      failure
    );
  });
});

describe("reviveTimestamps", () => {
  // Feature: Keep the message identity | Scenario: Dates in the data come back as dates
  it("turns timestamps into dates at any depth", () => {
    const date = new Date("2026-11-07T10:00:00.000Z");

    const revived = reviveTimestamps({
      at: Timestamp.fromDate(date),
      nested: { list: [Timestamp.fromDate(date), "text", 3] },
    }) as { at: Date; nested: { list: unknown[] } };

    assert.ok(revived.at instanceof Date);
    assert.strictEqual(revived.at.getTime(), date.getTime());
    assert.ok(revived.nested.list[0] instanceof Date);
    assert.deepStrictEqual(revived.nested.list.slice(1), ["text", 3]);
  });

  it("keeps values that are not timestamps", () => {
    const value = { text: "a", count: 2, flag: true, nothing: null, list: [1, 2] };

    assert.deepStrictEqual(reviveTimestamps(value), value);
  });
});
