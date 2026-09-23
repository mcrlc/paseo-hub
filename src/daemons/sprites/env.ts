const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/u;
const RESERVED_ENV_KEYS = new Set([
  "HOME",
  "PATH",
  "PASEO_HOME",
  "PASEO_PASSWORD",
  "PASEO_LISTEN",
  "PASEO_RELAY_ENABLED",
  "PASEO_WEB_UI_ENABLED",
]);
const VALUE_MAX = 8192;

export function spritesEnvKeyError(key: string): string | undefined {
  if (!ENV_KEY.test(key)) {
    return "Use capital letters, digits, and underscores, not starting with a digit.";
  }
  if (RESERVED_ENV_KEYS.has(key)) return `Hub sets ${key} on every sprite; choose another name.`;
  return undefined;
}

export function spritesEnvValueError(value: string): string | undefined {
  if (value === "") return "Enter a value.";
  if (value.length > VALUE_MAX) return `Keep the value to ${VALUE_MAX} characters or fewer.`;
  return undefined;
}
