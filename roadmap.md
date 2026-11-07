# Roadmap

Work planned for this library, driven by the rules of the my-f-startup reference architecture (reliable publication of integration events: ADR-003). The library stays generic: it depends on neither an event sourcing framework nor a message broker.

Legend: Done, Partial, Open, Not verified.

| Item | Status | Evidence and note |
|---|---|---|
| Record, publish after the commit and recover | Done | `createFirestoreOutbox` with `record`, `publishCommitted` and `publishPending` (0.1.0). Covered by unit, integration and end to end tests on the Firestore emulator |
| Publish the first version and make the services use it | Open | The version is not published yet. The user-service and the services bootstrap are the first dependents |
| Report the age of the oldest message | Done | `publishPending` returns `oldestAgeMs` (0.1.0). The service writes it as a metric and alerts on it (ADR-003) |
| Count the messages left in the outbox | Open | Needs a Firestore `count()` aggregate query, which the in-memory Firestore does not support. `failed` tells how many a run could not publish |
| Behavior of a publication that times out and succeeds later | Partial | An integration test shows the message staying in the outbox and being published again with the same id. It was not tried against a real broker |
| Recovery with more messages than the batch size at every run | Not verified | A run takes `batchSize` messages. How fast a large backlog drains with the run interval of the architecture was not measured |
