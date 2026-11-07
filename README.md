# @my-f-startup/google-firestore-outbox

Transactional outbox for Google Firestore.

Stores the messages of a change in the same Firestore transaction as the change itself, publishes them right after the commit, and publishes later the ones that were not published. It depends on neither an event sourcing framework nor a message broker: the publisher is a function you pass in. Includes unit, integration (in-memory Firestore), and E2E tests with the Firestore emulator via Testcontainers.

---

## Why this exists

Changing data in Firestore and publishing a message to a broker are two separate writes, and neither system can take part in a transaction of the other. If the process stops between them, or the broker is unavailable, the data is changed and the message is never published. This is the dual write problem.

Retrying the publication in memory does not close the gap: the retry ends with the process, and it does not help with an error that needs someone to act, such as a missing permission.

This package closes it with a transactional outbox:

- The message is written to a Firestore collection in the transaction that changes the data, so it exists if and only if the change was committed.
- After the commit, the messages are published and their documents are deleted.
- A recovery run publishes the documents that are still there.

---

## Features

- ✅ **Atomic with the change** – `record` writes on the transaction you already have
- ✅ **Broker independent** – the publisher is a function, so it works with Pub/Sub, Kafka, HTTP or anything else
- ✅ **Bounded wait** – the publication after the commit has a total time limit and never fails the request
- ✅ **Recovery** – `publishPending` publishes in batches what was left, oldest first
- ✅ **Stable identity** – a message keeps its id every time it is published, so consumers can discard duplicates
- ✅ **Dates stay dates** – Firestore timestamps come back as `Date` when a stored message is published

---

## Installation

```bash
npm install @my-f-startup/google-firestore-outbox
```

### Peer Dependencies

- `@google-cloud/firestore` ^7.10.0

---

## Quick Start

```ts
import { Firestore } from "@google-cloud/firestore";
import { createFirestoreOutbox } from "@my-f-startup/google-firestore-outbox";

const firestore = new Firestore({ projectId: "demo-project" });

const outbox = createFirestoreOutbox({
  firestore,
  collection: "orders-outbox",
  types: ["OrderPlaced"],
  publish: async (message) => {
    await broker.publish(message.type, message);
  },
});

const message = { messageId: crypto.randomUUID(), type: "OrderPlaced", data: { orderId: "order-1" } };

await firestore.runTransaction(async (transaction) => {
  transaction.set(firestore.collection("orders").doc("order-1"), { status: "placed" });
  outbox.record(transaction, [message]);
});

await outbox.publishCommitted([message]);
```

A job, called every few minutes by a scheduler, recovers what was not published:

```ts
const { published, failed, oldestAgeMs } = await outbox.publishPending();
```

`oldestAgeMs` is the age of the oldest message still in the outbox, or `null` when it is empty. A value that keeps growing means the publication is failing, which makes it the number to alert on.

### With an event store

`record` accepts any list of objects with `messageId`, `type`, `data` and optionally `metadata`, so it can be used directly as the hook of an event store that runs inside its transaction and hands over the appended events:

```ts
const eventStore = getFirestoreEventStore(firestore, {
  hooks: { beforeCommit: outbox.record },
});
```

---

## Mental model

### 1. Record

- `outbox.record(transaction, messages)`
- Runs inside your transaction and only writes to it
- Stores one document per message whose type is listed in `types`, keyed by the `messageId`
- Ignores the other messages

### 2. Publish after the commit

- `outbox.publishCommitted(messages)`
- Publishes the messages and deletes their documents
- Never throws: a message that fails stays in the outbox

### 3. Recover

- `outbox.publishPending()`
- Publishes the documents older than `minAgeMs` and deletes them
- Reports the age of the oldest document that is still stored
- Meant to be called by a scheduled job

---

## API

### `createFirestoreOutbox(options)`

**Options:**

| Property | Type | Default | Description |
| --- | --- | --- | --- |
| `firestore` | `Firestore` | required | The Firestore instance, the same one that runs the transactions |
| `collection` | `string` | required | Collection that holds the pending messages |
| `types` | `string[]` | required | Types of the messages that go through the outbox. Other messages are ignored |
| `publish` | `(message) => Promise<void>` | required | Publishes one message. It must throw when the publication failed |
| `minAgeMs` | `number` | `60000` | Age a stored message needs before `publishPending` takes it. It must be longer than `publishTimeoutMs`, so the job does not race the publication that follows the commit |
| `publishTimeoutMs` | `number` | `10000` | Total wait of `publishCommitted`, and wait for each message of `publishPending`. The publication is not cancelled when the time is over, so the message can be published once and again later |
| `batchSize` | `number` | `100` | Maximum number of messages one `publishPending` takes |
| `now` | `() => number` | `Date.now` | Clock in milliseconds, for tests |
| `logger` | `Logger` | none | Receives a warning for each message that fails |

**Returns:** `{ record, publishCommitted, publishPending }`

### `record(transaction, messages)`

Writes the documents on the transaction. It does not read, because Firestore rejects a read after a write in a transaction, and it has no other effect.

Firestore can run a transaction more than once when it conflicts, so `record` can run more than once for one change. Only the writes of the attempt that commits are kept, which is why the documents are keyed by the `messageId`: generate the id for each attempt, inside the transaction function, if the change itself must not reuse it.

### `publishCommitted(messages)`

**Returns:** `Promise<{ published, failed }>`

### `publishPending()`

Takes at most `batchSize` documents older than `minAgeMs`, oldest first. A message that fails does not stop the others.

**Returns:** `Promise<{ published, failed, oldestAgeMs }>`. It does not count the messages left in the outbox, because that needs an aggregate query that the in-memory Firestore does not support.

---

## Delivery guarantees

- **At least once.** The recovery run can publish a message that was published but whose document was not deleted yet, and two runs can overlap. The consumer must discard duplicates by `messageId`.
- **No ordering.** Messages recovered later arrive after newer ones.
- **No loss.** A message stored by a committed transaction stays until a publication succeeds.

---

## Stored document

```text
<collection>/<messageId>
  messageId: string
  type: string
  data: object
  metadata: object (optional)
  createdAt: number (milliseconds)
```

`data` and `metadata` must be values Firestore can store. A `Date` is stored as a timestamp and is published as a `Date` again.

---

## Testing philosophy

- **Unit tests** – Pure logic
- **Integration tests** – In-memory Firestore from `@emmett-community/emmett-google-firestore/testing`
- **E2E tests** – Real Firestore emulator via Testcontainers, including competing transactions that Firestore retries

### Emulator image for E2E tests

The E2E suite uses the Docker image `myfstartup/firebase-emulator-suite:15` via Testcontainers.
The container expects `PROJECT_ID` and supports mounting `firebase.json` and `.firebaserc` into `/app` for configuration.

---

## Tests

- Unit: `npm run test:unit`
- Integration (in-memory): `npm run test:int`
- E2E (Firestore emulator): `npm run test:e2e`
- All tests: `npm test`

---

## Build & Runtime

- Build JS: `npm run build` (outputs `dist/`)

---

## Compatibility

- Node.js: >= 20
- Firestore client: `@google-cloud/firestore` ^7.10.0

---

## Non-goals

- Choosing or running the scheduler of the recovery job
- Deduplication on the consumer side
- Ordering guarantees
- Retention of published messages: a published message is deleted

---

## Changelog

The [CHANGELOG.md](CHANGELOG.md) file is **automatically generated** during pull requests. Do not edit it manually.

### How it works

A GitHub Actions workflow runs [git-chglog](https://github.com/git-chglog/git-chglog) to generate the changelog from commit messages. Only commits following the [Conventional Commits](https://www.conventionalcommits.org/) format are included.

### Commit format

```text
<type>(<scope>): <description>
```

- **type**: Required. One of `feat`, `fix`, `refactor`, `perf`
- **scope**: Optional. Component or area affected (e.g., `outbox`, `support`)
- **description**: Required. Short summary of the change

### Recognized commit types

| Type       | Changelog section |
| ---------- | ----------------- |
| `feat`     | Added             |
| `fix`      | Fixed             |
| `refactor` | Changed           |
| `perf`     | Changed           |

Other types (`chore`, `docs`, `test`, `style`, `ci`, `build`) are not included in the changelog.

### Examples

```bash
feat: Add batch size to the recovery run
fix(outbox): Keep the message when the publication times out
refactor: Simplify the timeout helper
perf: Publish the messages of one batch in parallel
```

---

Made with ❤️ by My F* Startup
