// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { GeneralSection } from "../GeneralSection";
import type { SettingsFormState } from "../context";
import { fetchWorkflows } from "../../../../api";

vi.mock("react-i18next", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-i18next")>(),
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

vi.mock("../../../../api", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../../api")>(),
  fetchWorkflows: vi.fn(),
}));

const WORKFLOWS = [
  { id: "WF-001", name: "My workflow", ir: {} },
] as unknown as import("@fusion/core").WorkflowDefinition[];

function GeneralHost({ initialForm }: { initialForm: Partial<SettingsFormState> }) {
  const [form, setForm] = useState(initialForm as SettingsFormState);
  return (
    <GeneralSection
      form={form}
      setForm={setForm}
      addToast={vi.fn()}
      prefixError={null}
      setPrefixError={vi.fn()}
    />
  );
}

beforeEach(() => {
  vi.mocked(fetchWorkflows).mockReset();
  vi.mocked(fetchWorkflows).mockResolvedValue(WORKFLOWS);
});
afterEach(() => cleanup());

describe("GeneralSection without bundled workflows", () => {
  it("offers custom workflow settings without built-in enablement controls", async () => {
    render(<GeneralHost initialForm={{ enabledBuiltinWorkflowIds: ["builtin:coding"] }} />);
    await waitFor(() => expect(fetchWorkflows).toHaveBeenCalled());
    expect(screen.queryByText("Fusion workflows")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Coding")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-undo-workflow-select")).toHaveValue("");
    expect(screen.getAllByRole("option", { name: "My workflow" }).length).toBeGreaterThan(0);
  });
  it("supports a fresh project with no workflow templates", async () => {
    vi.mocked(fetchWorkflows).mockResolvedValue([]);
    render(<GeneralHost initialForm={{}} />);
    await waitFor(() => expect(fetchWorkflows).toHaveBeenCalled());
    expect(screen.queryByText("Fusion workflows")).not.toBeInTheDocument();
    expect(screen.getByTestId("ai-undo-workflow-select")).toHaveValue("");
  });
});
