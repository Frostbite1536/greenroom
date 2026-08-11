import assert from "node:assert/strict";
import { test } from "node:test";
import { PASSWORD_MAX_LENGTH } from "@/lib/password-credential";
import {
  PASSWORD_MIN_LENGTH,
  PASSWORD_MISMATCH_MESSAGE,
  PASSWORD_TOO_LONG_MESSAGE,
  PASSWORD_TOO_SHORT_MESSAGE,
  checkNewPassword,
  passwordLength,
} from "./password-policy";

test("the floor is a length rule and it is enforced at the boundary, not one short of it", () => {
  const short = "a".repeat(PASSWORD_MIN_LENGTH - 1);
  const exact = "a".repeat(PASSWORD_MIN_LENGTH);
  assert.deepEqual(checkNewPassword(short, short), {
    ok: false,
    fieldErrors: { password: [PASSWORD_TOO_SHORT_MESSAGE] },
  });
  assert.deepEqual(checkNewPassword(exact, exact), { ok: true, password: exact });
});

test("length is counted in code points, so an emoji password cannot buy characters it does not have", () => {
  // Nine astral characters: 18 UTF-16 units, which a naive `.length` would wave
  // through against a floor of ten.
  const nine = "😀".repeat(9);
  assert.equal(nine.length, 18);
  assert.equal(passwordLength(nine), 9);
  assert.equal(checkNewPassword(nine, nine).ok, false);
  const ten = "😀".repeat(PASSWORD_MIN_LENGTH);
  assert.equal(checkNewPassword(ten, ten).ok, true);
});

test("the upper bound is the credential module's, so scrypt is never asked to chew an essay", () => {
  const long = "a".repeat(PASSWORD_MAX_LENGTH + 1);
  assert.deepEqual(checkNewPassword(long, long), {
    ok: false,
    fieldErrors: { password: [PASSWORD_TOO_LONG_MESSAGE] },
  });
  const atLimit = "a".repeat(PASSWORD_MAX_LENGTH);
  assert.equal(checkNewPassword(atLimit, atLimit).ok, true);
});

test("a mismatched confirmation is its own field error, and both problems arrive together", () => {
  const verdict = checkNewPassword("short", "different");
  assert.equal(verdict.ok, false);
  assert.ok(!verdict.ok);
  // One pass, both messages: three attempts to learn two rules is a bad trade.
  assert.deepEqual(Object.keys(verdict.fieldErrors).sort(), ["confirmPassword", "password"]);
  assert.deepEqual(verdict.fieldErrors.confirmPassword, [PASSWORD_MISMATCH_MESSAGE]);
});

test("the comparison is exact — no trimming, no case folding, no unicode charity", () => {
  const password = "correct horse battery";
  assert.equal(checkNewPassword(password, `${password} `).ok, false);
  assert.equal(checkNewPassword(password, password.toUpperCase()).ok, false);
  assert.equal(checkNewPassword(password, password).ok, true);
});

test("non-string input fails closed rather than coercing into something acceptable", () => {
  for (const hostile of [undefined, null, 42, {}, [], { length: 99 }]) {
    assert.equal(checkNewPassword(hostile, hostile).ok, false, `${JSON.stringify(hostile)} must not pass`);
  }
  // A valid password with a non-string confirmation is still a mismatch, never
  // an accidental pass through `==`.
  const valid = "a".repeat(PASSWORD_MIN_LENGTH);
  assert.equal(checkNewPassword(valid, undefined).ok, false);
});
