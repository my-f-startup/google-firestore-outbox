Feature: Record messages in the transaction
  As a service owner
  I want the messages to be stored in the same transaction as the data they describe
  So that a message exists if and only if the change was committed

  Scenario: Messages of a listed type are stored with the transaction
    Given an outbox for the types "UserMarkedForRemoval"
    When a transaction records a message of type "UserMarkedForRemoval" and commits
    Then the outbox collection holds a document for the message

  Scenario: Messages of a type that is not listed are not stored
    Given an outbox for the types "UserMarkedForRemoval"
    When a transaction records a message of type "UserInformationChanged" and commits
    Then the outbox collection is empty

  Scenario: Nothing is stored when the transaction fails
    Given an outbox for the types "UserMarkedForRemoval"
    When a transaction records a message of type "UserMarkedForRemoval" and then fails
    Then the outbox collection is empty

  Scenario: Only the attempt that commits is kept when the transaction is retried
    Given an outbox for the types "UserMarkedForRemoval"
    When competing transactions record messages and Firestore retries some of them
    Then the outbox collection holds one document for each committed message
