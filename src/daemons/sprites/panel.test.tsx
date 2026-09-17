import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import {
  SpritesEnvCard,
  SpritesSettingsContent,
  spritesEnvFormValues,
  spritesFormValues,
  submitSpritesForm,
} from "./panel.js";

const CONFIGURED = {
  configured: true,
  memoryMb: 16384,
  envKeys: [],
  updatedAt: "2026-09-17T09:00:00.000Z",
  updatedByUserId: "user-1",
};
const UNCONFIGURED = {
  configured: false,
  memoryMb: null,
  envKeys: [],
  updatedAt: null,
  updatedByUserId: null,
};
const ignore = () => undefined;

const REJECTED = { token: "Sprites rejected this token." };

function markup(configured: boolean, rejected = false): string {
  return renderToStaticMarkup(
    <SpritesSettingsContent
      snapshot={configured ? CONFIGURED : UNCONFIGURED}
      busy={false}
      saved={false}
      error={undefined}
      {...(rejected ? { serverErrors: REJECTED } : {})}
      onReset={ignore}
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

  it("clears the previous save result on a submit that fails validation", () => {
    const calls: string[] = [];
    const errors = submitSpritesForm(
      form({ token: "", memoryMb: "8192" }),
      () => calls.push("reset"),
      () => calls.push("save"),
    );
    assert.deepEqual(calls, ["reset"]);
    assert.deepEqual(errors, { token: "Enter the Sprites organization token." });
  });

  it("shows a token Sprites rejected as an error on the token field", () => {
    assert.match(
      markup(false, true),
      /id="sprites-token-error"[^>]*>Sprites rejected this token\./u,
    );
  });
});

function envMarkup(keys: string[]): string {
  return renderToStaticMarkup(
    <SpritesEnvCard
      keys={keys}
      formKey="k"
      busy={false}
      saved={false}
      error={undefined}
      removeError={undefined}
      onReset={ignore}
      onSet={ignore}
      onRemove={ignore}
    />,
  );
}

describe("Sprites daemon environment", () => {
  it("lists key names with row actions and no values", () => {
    const html = envMarkup(["API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
    assert.match(html, /aria-label="Daemon environment variables"/u);
    assert.match(html, />API_KEY</u);
    assert.match(html, /aria-label="Actions for CLAUDE_CODE_OAUTH_TOKEN"/u);
    assert.match(html, /write-only/u);
    assert.doesNotMatch(html, /No variables/u);
  });

  it("shows the empty state when nothing is set", () => {
    const html = envMarkup([]);
    assert.match(html, /No variables/u);
    assert.doesNotMatch(html, /Daemon environment variables/u);
  });

  it("offers a name field and an empty password value field", () => {
    const html = envMarkup([]);
    assert.match(html, /<input[^>]*name="key"/u);
    const value = /<input[^>]*name="value"[^>]*>/u.exec(html)?.[0] ?? "";
    assert.match(value, /type="password"/u);
    assert.doesNotMatch(value, /value=/u);
  });

  it("validates the name and value before sending", () => {
    assert.deepEqual(spritesEnvFormValues(form({ key: "lower", value: " " })).errors, {
      key: "Use capital letters, digits, and underscores, not starting with a digit.",
      value: "Enter a value.",
    });
    assert.deepEqual(spritesEnvFormValues(form({ key: "PATH", value: "v" })).errors, {
      key: "Hub sets PATH on every sprite; choose another name.",
    });
    assert.deepEqual(
      spritesEnvFormValues(form({ key: " CLAUDE_CODE_OAUTH_TOKEN ", value: " t " })).values,
      { key: "CLAUDE_CODE_OAUTH_TOKEN", value: "t" },
    );
  });
});
