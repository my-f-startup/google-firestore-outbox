Feature: Recover unpublished messages
  As a service owner
  I want the messages that were not published to be published later
  So that no stored message is lost when the process stops or the publisher is unavailable

  Scenario: A stored message that is old enough is published and removed
    Given a message stored longer ago than the minimum age
    When the pending messages are published
    Then the message reaches the publisher
    And the outbox collection is empty

  Scenario: A recent message is left for the publication that follows the commit
    Given a message stored less than the minimum age ago
    When the pending messages are published
    Then the message does not reach the publisher
    And the message stays in the outbox collection

  Scenario: A failed message does not block the others
    Given two old stored messages and a publisher that fails for the first
    When the pending messages are published
    Then the second message reaches the publisher
    And the first message stays in the outbox collection

  Scenario: The age of the oldest stored message is reported
    Given a stored message that cannot be published
    When the pending messages are published
    Then the result reports the age of that message

  Scenario: The batch is bounded
    Given more old stored messages than the batch size
    When the pending messages are published
    Then only the oldest messages of the batch size are published
