import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { recreateSpriteMessage } from "./functions.js";

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
