import fs from "fs";
import path from "path";
import { createManagedConfigWriteGuard } from "../sandbox/managed-config-guard.ts";
import { PathGuard } from "../sandbox/path-guard.ts";
import { deriveSandboxPolicy } from "../sandbox/policy.ts";

type Operation = "read" | "write" | "delete";

type Options = {
  cwd: string;
  agentDir: string;
  workspace?: string | null;
  workspaceFolders?: string[];
  hanakoHome: string;
  getAuthorizedFolders?: () => string[];
  getSandboxEnabled?: () => boolean;
  getExternalReadPaths?: () => string[];
};

export class ResourceAccessPolicy {
  declare cwd: string;
  declare agentDir: string;
  declare workspace: string | null;
  declare workspaceFolders: string[];
  declare hanakoHome: string;
  declare getAuthorizedFolders: () => string[];
  declare getSandboxEnabled: () => boolean;
  declare getExternalReadPaths?: () => string[];
  declare checkManagedConfigWrite: (absolutePath: string, operation: Operation) => { allowed: boolean; reason?: string };

  constructor({
    cwd,
    agentDir,
    workspace = null,
    workspaceFolders = [],
    hanakoHome,
    getAuthorizedFolders = () => [],
    getSandboxEnabled = () => false,
    getExternalReadPaths,
  }: Options) {
    this.cwd = cwd;
    this.agentDir = agentDir;
    this.workspace = workspace;
    this.workspaceFolders = Array.isArray(workspaceFolders) ? workspaceFolders : [];
    this.hanakoHome = hanakoHome;
    this.getAuthorizedFolders = getAuthorizedFolders;
    this.getSandboxEnabled = getSandboxEnabled;
    this.getExternalReadPaths = getExternalReadPaths;
    this.checkManagedConfigWrite = createManagedConfigWriteGuard({ hanakoHome });
  }

  check(absolutePath: string, operation: Operation) {
    const managedConfigCheck = this.checkManagedConfigWrite(absolutePath, operation);
    if (!managedConfigCheck.allowed) return managedConfigCheck;
    if (!this.getSandboxEnabled()) return { allowed: true };
    const result = new PathGuard(this.makeSandboxPolicy()).check(absolutePath, operation);
    if (result.allowed) return result;
    if (operation === "read" && this.hasExternalReadGrant(absolutePath)) {
      return { allowed: true };
    }
    return result;
  }

  makeSandboxPolicy() {
    return deriveSandboxPolicy({
      agentDir: this.agentDir,
      cwd: this.cwd,
      workspace: this.workspace,
      workspaceFolders: [
        ...this.workspaceFolders,
        ...this.resolveAuthorizedFolders(),
      ],
      hanakoHome: this.hanakoHome,
      mode: "standard",
    });
  }

  resolveAuthorizedFolders() {
    try {
      const folders = this.getAuthorizedFolders();
      return Array.isArray(folders) ? folders : [];
    } catch {
      return [];
    }
  }

  hasExternalReadGrant(absolutePath: string) {
    if (!absolutePath || typeof this.getExternalReadPaths !== "function") return false;
    try {
      const grants = this.getExternalReadPaths() || [];
      return Array.isArray(grants) && grants.some((grantPath) => (
        grantPath && externalReadGrantCovers(absolutePath, grantPath)
      ));
    } catch {
      return false;
    }
  }
}

function normalizeExistingOrResolvedPath(filePath: string) {
  const resolved = path.resolve(filePath);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isInsideRoot(filePath: string, root: string) {
  const rel = path.relative(root, filePath);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function externalReadGrantCovers(targetPath: string, grantPath: string) {
  const target = normalizeExistingOrResolvedPath(targetPath);
  const grant = normalizeExistingOrResolvedPath(grantPath);
  if (target === grant) return true;
  try {
    return fs.statSync(grant).isDirectory() && isInsideRoot(target, grant);
  } catch {
    return false;
  }
}
