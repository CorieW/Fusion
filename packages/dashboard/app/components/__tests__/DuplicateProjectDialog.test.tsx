import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DuplicateProjectDialog } from "../DuplicateProjectDialog";
import { duplicateProject, type ProjectInfo } from "../../api/projects/projects";
vi.mock("../../api/projects/projects", () => ({ duplicateProject: vi.fn() }));
vi.mock("../FloatingWindow", () => ({ FloatingWindow: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const project = { id: "source-project", name: "Source", path: "A:/Source Project", status: "active", isolationMode: "in-process", createdAt: "", updatedAt: "" } as ProjectInfo;
describe("Duplicate Project dialog", () => {
  it("keeps inputs mounted while typing and submits name/path with the source ID", async () => {
    const onCreated = vi.fn();
    vi.mocked(duplicateProject).mockResolvedValue({ ...project, id: "new-project", status: "paused" });
    render(<DuplicateProjectDialog project={project} onClose={() => {}} onCreated={onCreated} />);
    const user = userEvent.setup();
    const name = screen.getByLabelText("Project name");
    await user.clear(name); await user.type(name, "New Project");
    expect(screen.getByLabelText("Project name")).toBe(name);
    const path = screen.getByLabelText("New folder");
    await user.clear(path); await user.type(path, "A:/New Project");
    await user.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(duplicateProject).toHaveBeenCalledWith("source-project", { name: "New Project", path: "A:/New Project" });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: "new-project", status: "paused" })));
  });
  it("shows copy errors without closing the dialog or losing edited input", async () => {
    const onCreated = vi.fn();
    vi.mocked(duplicateProject).mockRejectedValue(new Error("Destination must be a new folder"));
    render(<DuplicateProjectDialog project={project} onClose={() => {}} onCreated={onCreated} />);
    fireEvent.click(screen.getByRole("button", { name: "Duplicate" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Destination must be a new folder");
    expect(screen.getByLabelText("New folder")).toHaveValue("A:/Source Project-copy");
    expect(onCreated).not.toHaveBeenCalled();
  });
});
