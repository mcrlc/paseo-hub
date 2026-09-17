import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { SpriteSection, TriggerDocumentWarnings, type TriggerSprite } from "./panel.js";

const LIVE: TriggerSprite = {
  status: "alive",
  name: "trigger-9f2",
  memoryMb: 16384,
  lastRunAt: "2026-09-17T09:00:00.000Z",
};

const ignore = () => undefined;

function section(sprite: TriggerSprite, error?: string): string {
  return renderToStaticMarkup(
    <SpriteSection sprite={sprite} canManage busy={false} error={error} onRecreate={ignore} />,
  );
}

describe("trigger sprite section", () => {
  it("summarises the live sprite and offers to recreate it", () => {
    const html = section(LIVE);

    assert.match(html, />Alive</u);
    assert.match(html, />trigger-9f2</u);
    assert.match(html, />16384 MB</u);
    assert.match(html, /aria-label="Sprite actions"/u);
  });

  it("says the sprite has not been created and offers nothing to recreate", () => {
    const html = section({ status: null, name: null, memoryMb: null, lastRunAt: null });

    assert.match(html, />Not created</u);
    assert.doesNotMatch(html, /aria-label="Sprite actions"/u);
  });

  it("keeps a retired sprite on the page without an action", () => {
    const html = section({ ...LIVE, status: "terminated" });

    assert.match(html, />Terminated</u);
    assert.doesNotMatch(html, /aria-label="Sprite actions"/u);
  });

  it("reports a refused recreation", () => {
    assert.match(
      section(LIVE, "Recreating this sprite destroys it and ends its 1 running execution."),
      /ends its 1 running execution/u,
    );
  });
});

describe("trigger document warnings", () => {
  const sprite = `name: reviewer
on:
  github.issue_comment: {}
run:
  target: { kind: sprite, bootstrap: install, cwd: /workspace }
  agent: { provider: claude, mode: bypassPermissions }
  prompt: Review it.
`;

  it("warns that a leased credential ends the conversation it is meant to continue", () => {
    const html = renderToStaticMarkup(
      <TriggerDocumentWarnings
        yaml={sprite.replace("  prompt:", "  github: { connection: acme-github }\n  prompt:")}
      />,
    );

    assert.match(html, /run\.target\.env/u);
  });

  it("stays out of the way of a document that asks for nothing contradictory", () => {
    assert.equal(renderToStaticMarkup(<TriggerDocumentWarnings yaml={sprite} />), "");
  });
});
