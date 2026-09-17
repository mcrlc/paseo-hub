import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { respondWithFailure } from "../failures/index.js";
import { recreateSpriteMessage, saveTriggerMessages } from "./functions.js";

const FALLBACK = "Hub couldn't recreate this sprite. Reload its status before trying again.";

/**
 * `SpriteBusyError` is thrown in a different bundle chunk than the handler that catches it, so
 * `instanceof` is false by the time it arrives. A plain `Error` carrying only the name is what
 * actually survives that boundary.
 */
function crossChunkError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("recreate sprite failures", () => {
  it("says only its own sentence about an error the reader cannot act on", () => {
    assert.equal(recreateSpriteMessage(new Error("connect ECONNREFUSED 10.0.0.1:5432")), FALLBACK);
    assert.equal(recreateSpriteMessage("sprites API rejected the token"), FALLBACK);
  });

  it("passes through the one refusal the reader can act on", () => {
    const busy = crossChunkError(
      "SpriteBusyError",
      "Recreating this sprite destroys it and ends its 2 running executions. Try again once it is idle.",
    );

    assert.equal(recreateSpriteMessage(busy), busy.message);
  });
});

const SAVE_FALLBACK = "Hub couldn't save the trigger. Reload the page and try again.";

const silent = { warn() {}, error() {} };

function saveFailureMessage(error: unknown): string {
  const result = respondWithFailure(
    error,
    { operation: "trigger.save", component: "triggers" },
    saveTriggerMessages(error),
    { logger: silent },
  );
  assert.equal(result.status, "error");
  return result.error.message;
}

describe("save trigger failures", () => {
  it("says only its own sentence about a request with no session", () => {
    const message = saveFailureMessage(new Error("unauthenticated"));

    assert.ok(message.startsWith(SAVE_FALLBACK));
    assert.ok(!message.includes("unauthenticated"));
  });

  it("says only its own sentence about an unexpected error", () => {
    assert.ok(saveFailureMessage(new Error("boom")).startsWith(SAVE_FALLBACK));
  });

  it("passes through the field messages the editor renders", () => {
    const document = crossChunkError(
      "TriggerDocumentError",
      "run.target.kind: Sprite targets are not enabled for this organization.",
    );

    assert.ok(saveFailureMessage(document).startsWith(document.message));
  });

  it("passes through a sprite prerequisite refusal", () => {
    const prerequisite = crossChunkError(
      "TriggerDocumentError",
      "run.target.kind: Sprites are not configured for this organization.",
    );

    assert.ok(saveFailureMessage(prerequisite).startsWith(prerequisite.message));
  });
});
