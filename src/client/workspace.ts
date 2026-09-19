import path from "node:path";
import {
  type Credential,
  type ProjectConfig,
  findCredential,
  findWorkspaceRoot,
  readProjectConfig,
} from "./config.ts";
import { HubClient } from "./hub-client.ts";

export interface Workspace {
  root: string;
  config: ProjectConfig;
  credential: Credential;
  /** Member-scoped client (human / device). */
  hub: HubClient;
}

export type WorkspaceLookup = { ok: true; ws: Workspace } | { ok: false; reason: string };

/** Resolve the repo, its committed Axis config, and this machine's credential for it. */
export function loadWorkspace(start?: string): WorkspaceLookup {
  const hint =
    process.env.AXIS_WORKSPACE_ROOT ?? process.env.CLAUDE_PROJECT_DIR ?? start ?? process.cwd();
  const root = findWorkspaceRoot(path.resolve(hint));
  if (!root) return { ok: false, reason: "Not inside a repository. Run `axis init` in your repo." };
  const config = readProjectConfig(root);
  if (!config)
    return { ok: false, reason: `Axis is not set up in ${root}. Run \`axis init\` there.` };
  const credential = findCredential(config.hub, config.project);
  if (!credential)
    return {
      ok: false,
      reason: `This machine has not joined project ${config.name}. Run \`axis join <invite>\` (get one with \`axis invite\`).`,
    };
  return {
    ok: true,
    ws: { root, config, credential, hub: new HubClient(config.hub, credential.memberToken) },
  };
}
