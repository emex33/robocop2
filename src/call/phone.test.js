import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeDialPhone } from "./phone.js";

describe("normalizeDialPhone", () => {
  it("strips a doubled German mobile prefix", () => {
    assert.equal(normalizeDialPhone("494915114626"), "4915114626");
    assert.equal(normalizeDialPhone("494917028517"), "4917028517");
    assert.equal(normalizeDialPhone("49491764189"), "491764189");
    assert.equal(normalizeDialPhone("494949172235"), "49172235");
  });

  it("strips a doubled Spanish mobile prefix", () => {
    assert.equal(normalizeDialPhone("3434631523130"), "34631523130");
    assert.equal(normalizeDialPhone("3434963830803"), "34963830803");
  });

  it("leaves a correct German mobile alone", () => {
    assert.equal(normalizeDialPhone("4915110224938"), "4915110224938");
  });

  it("strips + / spaces / 00 and then a doubled prefix", () => {
    assert.equal(normalizeDialPhone("+49 49 151 114626"), "49151114626");
    assert.equal(normalizeDialPhone("00494917028517"), "4917028517");
  });
});
