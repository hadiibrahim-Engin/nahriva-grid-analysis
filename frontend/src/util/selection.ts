import type { ElementIdentity, Run } from "../api/types.ts";

export function selectionPayload(
  run: Pick<Run, "id" | "project" | "study_case">,
  element: ElementIdentity,
) {
  return {
    schemaVersion: 1,
    action: "select-element",
    runId: run.id,
    project: run.project,
    studyCase: run.study_case,
    element: {
      id: element.id,
      name: element.name,
      className: element.className,
      type: element.type,
      path: element.path,
    },
  };
}
export function filterQuery(values: Record<string, string>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value) params.set(key, value);
  return params.toString();
}
