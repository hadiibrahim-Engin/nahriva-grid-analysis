import test from "node:test";
import assert from "node:assert/strict";
import { filterQuery, selectionPayload } from "./selection.ts";

test("selection preserves stable IDs and full PF path independently of display name", () => {
  const payload = selectionPayload(
    { id: "run-1", project: "P", study_case: "S" },
    {
      id: "uuid-7",
      name: "Gleicher Name",
      className: "ElmLne",
      type: "line",
      path: "P/Netz/A.ElmLne",
    },
  );
  assert.equal(payload.element.id, "uuid-7");
  assert.equal(payload.element.path, "P/Netz/A.ElmLne");
  assert.equal(payload.studyCase, "S");
});
test("filter query preserves reserved characters and omits empty values", () => {
  const values = new URLSearchParams(
    filterQuery({ run_id: "r&1", search: "Süd + Nord", compare_run_id: "" }),
  );
  assert.equal(values.get("search"), "Süd + Nord");
  assert.equal(values.get("run_id"), "r&1");
  assert.equal(values.has("compare_run_id"), false);
});
