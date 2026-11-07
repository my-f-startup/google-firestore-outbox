Feature: Publish messages after the commit
  As a service owner
  I want the committed messages to be published right away
  So that consumers receive them without waiting for a recovery run

  Scenario: A published message is removed from the outbox
    Given a stored message
    When the committed messages are published and the publication succeeds
    Then the message reaches the publisher
    And the outbox collection is empty

  Scenario: A failed publication leaves the message in the outbox
    Given a stored message
    When the committed messages are published and the publication fails
    Then the message stays in the outbox collection
    And the failure is reported in the result

  Scenario: The wait is bounded
    Given a stored message
    When the committed messages are published and the publisher does not answer in time
    Then the message stays in the outbox collection
    And the call returns when the time is over

  Scenario: A publisher that answers after the time is over
    Given a stored message and a publisher that answers after the time is over
    When the committed messages are published
    Then the message stays in the outbox collection
    And a later recovery publishes it again with the same message id

  Scenario: Messages of a type that is not listed are not published
    Given an outbox for the types "UserMarkedForRemoval"
    When the committed messages include a message of type "UserInformationChanged"
    Then that message is not published
