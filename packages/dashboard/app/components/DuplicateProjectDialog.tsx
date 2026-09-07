import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getErrorMessage } from "@fusion/core";
import { FloatingWindow } from "./FloatingWindow";
import { duplicateProject, type ProjectInfo } from "../api/projects/projects";
import "./DuplicateProjectDialog.css";

export function DuplicateProjectDialog({ project, onClose, onCreated }: { project: ProjectInfo; onClose: () => void; onCreated: (project: ProjectInfo) => void }) {
  const { t } = useTranslation("app");
  const [name, setName] = useState(project.name + " (copy)");
  const [path, setPath] = useState(project.path + "-copy");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  return <FloatingWindow title={t("projects.duplicate", "Duplicate Project")} windowKey="duplicate-project" onClose={() => { if (!pending.current) onClose(); }}>
    <form className="duplicate-project-form" onSubmit={async event => {
      event.preventDefault();
      if (pending.current) return;
      pending.current = true;
      setBusy(true);
      setError("");
      try { onCreated(await duplicateProject(project.id, { name: name.trim(), path: path.trim() })); }
      catch (failure) { setError(getErrorMessage(failure)); }
      finally { pending.current = false; setBusy(false); }
    }}>
      <p>{t("projects.duplicateDescription", "Copy workflows, agents, and project settings into a new folder. The copy starts paused with agent heartbeats off. Tasks, history, and working files are not copied.")}</p>
      <label>{t("projects.name", "Project name")}<input required value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
      <label>{t("projects.destination", "New folder")}<input required value={path} onChange={event => setPath(event.target.value)} disabled={busy} /></label>
      {error && <p role="alert">{error}</p>}
      <div className="duplicate-project-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>{t("common.cancel", "Cancel")}</button><button type="submit" className="btn btn-primary" disabled={busy || !name.trim() || !path.trim()}>{busy ? t("common.copying", "Copying?") : t("common.duplicate", "Duplicate")}</button></div>
    </form>
  </FloatingWindow>;
}
