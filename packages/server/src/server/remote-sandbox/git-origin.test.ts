import { describe, expect, test } from "vitest";

import { normalizeToHttps } from "./git-origin.js";

describe("normalizeToHttps", () => {
  test("rewrites scp-form ssh remotes to https", () => {
    expect(normalizeToHttps("git@github.com:acme/app.git")).toBe("https://github.com/acme/app.git");
  });

  test("rewrites ssh:// remotes to https", () => {
    expect(normalizeToHttps("ssh://git@github.com/acme/app.git")).toBe(
      "https://github.com/acme/app.git",
    );
  });

  test("leaves https remotes untouched", () => {
    expect(normalizeToHttps("https://github.com/acme/app.git")).toBe(
      "https://github.com/acme/app.git",
    );
  });
});
