import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { SpritesSettingsContent, spritesFormValues } from "./panel.js";

const CONFIGURED = {
  configured: true,
  memoryMb: 16384,
  updatedAt: "2026-09-17T09:00:00.000Z",
  updatedByUserId: "user-1",
};
const UNCONFIGURED = { configured: false, memoryMb: null, updatedAt: null, updatedByUserId: null };
const ignore = () => undefined;

function markup(configured: boolean): string {
  return renderToStaticMarkup(
    <SpritesSettingsContent
      snapshot={configured ? CONFIGURED : UNCONFIGURED}
      busy={false}
      saved={false}
      error={undefined}
      onSave={ignore}
    />,
  );
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

describe("Sprites settings form", () => {
  it("offers an empty password field that replaces a stored token", () => {
    const html = markup(true);
    assert.match(html, /New token \(replaces the stored token\)/u);
    const token = /<input[^>]*name="token"[^>]*>/u.exec(html)?.[0] ?? "";
    assert.match(token, /type="password"/u);
    assert.doesNotMatch(token, /value=/u);
    assert.match(html, /value="16384"/u);
  });

  it("defaults memory to 8192 before anything is stored", () => {
    assert.match(markup(false), /value="8192"/u);
  });

  it("requires a token and a positive whole number of megabytes", () => {
    assert.deepEqual(spritesFormValues(form({ token: " ", memoryMb: "0" })).errors, {
      token: "Enter the Sprites organization token.",
      memoryMb: "Enter a whole number of megabytes above zero.",
    });
    assert.equal(spritesFormValues(form({ token: "t", memoryMb: "1.5" })).values, undefined);
    assert.deepEqual(spritesFormValues(form({ token: " t ", memoryMb: "" })).values, {
      token: "t",
      memoryMb: 8192,
    });
  });
});
