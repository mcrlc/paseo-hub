import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { SpriteBusyError } from "./dashboard.js";
import { recreateSpriteFailure } from "./functions.js";

const FALLBACK = "Hub couldn't recreate this sprite. Reload its status before trying again.";

function message(error: unknown): string {
  const result = recreateSpriteFailure(error, "acme");
  assert.equal(result.status, "error");
  return result.error.message;
}

describe("recreate sprite failures", () => {
  it("says only its own sentence about an error the reader cannot act on", () => {
    assert.match(message(new Error("connect ECONNREFUSED 10.0.0.1:5432")), /^Hub couldn't/u);
    assert.doesNotMatch(message(new Error("connect ECONNREFUSED 10.0.0.1:5432")), /ECONNREFUSED/u);
    assert.equal(message(new Error("sprites API rejected the token")).startsWith(FALLBACK), true);
  });

  it("passes through the one refusal the reader can act on", () => {
    assert.equal(
      message(new SpriteBusyError(2)),
      "Recreating this sprite destroys it and ends its 2 running executions. Try again once it is idle.",
    );
  });
});
