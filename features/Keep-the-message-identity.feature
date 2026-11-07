Feature: Keep the message identity
  As a consumer of the published messages
  I want a message to carry the same identity every time it is published
  So that I can discard the copies I already processed

  Scenario: The document is keyed by the message id
    Given a recorded message with id "message-1"
    Then the outbox collection holds the document "message-1"

  Scenario: A message recovered later has the same id as the one published after the commit
    Given a recorded message with id "message-1"
    When the pending messages are published
    Then the publisher receives the message id "message-1"

  Scenario: Dates in the data come back as dates
    Given a recorded message whose data holds a date
    When the pending messages are published
    Then the publisher receives the same date as a Date
