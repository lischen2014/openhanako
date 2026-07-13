import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

import {
  PERSISTENCE_EXEMPTIONS,
  PERSISTENT_STORES,
} from "../shared/persistence/store-registry.ts";
import {
  FUTURE_EPOCH_COORDINATOR_PHASE,
  STARTUP_PHASES,
  startupPhaseIndex,
} from "../shared/persistence/startup-phases.ts";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, "..");
export const PRODUCTION_ROOTS = Object.freeze(["server", "core", "hub", "lib", "shared", "plugins"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);

const FS_METHOD_KINDS = new Map([
  ["writeFile", "write-file"],
  ["writeFileSync", "write-file"],
  ["createWriteStream", "write-file"],
  ["appendFile", "append-file"],
  ["appendFileSync", "append-file"],
  ["rename", "rename"],
  ["renameSync", "rename"],
  ["copyFile", "copy-file"],
  ["copyFileSync", "copy-file"],
  ["cp", "copy-file"],
  ["cpSync", "copy-file"],
  ["mkdir", "mkdir"],
  ["mkdirSync", "mkdir"],
]);
const ATOMIC_HELPERS = new Set([
  "atomicWriteSync",
  "atomicWriteFile",
  "atomicWriteFileSync",
  "writeJsonAtomic",
  "writeJsonFile",
  "safeWriteJson",
]);
const PERSISTENT_CONSTRUCTORS = new Set([
  "ActivityStore",
  "ConfirmStore",
  "CronStore",
  "DeferredResultStore",
  "FactStore",
  "InputDraftsStore",
  "PreferencesManager",
  "SessionManifestStore",
  "SessionProjectCatalogStore",
  "SkillBundleStore",
  "SubagentRunStore",
  "SubagentThreadStore",
  "TaskRegistry",
  "UsageLedger",
  "WebSessionStore",
  "WorkflowActivityStore",
  "WorkflowJournal",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function listSourceFiles(rootDir) {
  const files = [];
  for (const relativeRoot of PRODUCTION_ROOTS) {
    const absoluteRoot = path.join(rootDir, relativeRoot);
    if (!fs.existsSync(absoluteRoot)) {
      throw new Error(`persistence scan root is missing: ${relativeRoot}`);
    }
    const stack = [absoluteRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          const relativeDirectory = toPosix(path.relative(rootDir, absolute));
          if (/^plugins\/[^/]+\/(?:tests|__tests__)(?:\/|$)/.test(`${relativeDirectory}/`)) continue;
          stack.push(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!SOURCE_EXTENSIONS.has(path.extname(entry.name))) continue;
        if (entry.name.endsWith(".d.ts") || entry.name.endsWith(".d.cts")) continue;
        files.push(toPosix(path.relative(rootDir, absolute)));
      }
    }
  }
  return files.sort();
}

function moduleText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function isFsModule(value) {
  return value === "fs" || value === "node:fs" || value === "fs/promises" || value === "node:fs/promises";
}

function propertyNameText(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return null;
}

function expressionRootName(node) {
  let current = node;
  while (ts.isPropertyAccessExpression(current)) current = current.expression;
  return ts.isIdentifier(current) ? current.text : null;
}

function collectBindings(source) {
  const fsNamespaces = new Set(["fs", "fsp"]);
  const directCalls = new Map();
  const databaseConstructors = new Set(["Database"]);

  const registerNamedBinding = (importedName, localName) => {
    if (importedName === "promises") fsNamespaces.add(localName);
    if (FS_METHOD_KINDS.has(importedName)) directCalls.set(localName, FS_METHOD_KINDS.get(importedName));
    if (ATOMIC_HELPERS.has(importedName)) directCalls.set(localName, "atomic-write");
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const importedModule = moduleText(statement.moduleSpecifier);
      const clause = statement.importClause;
      if (isFsModule(importedModule) && clause) {
        if (clause.name) fsNamespaces.add(clause.name.text);
        if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          fsNamespaces.add(clause.namedBindings.name.text);
        }
        if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            registerNamedBinding(element.propertyName?.text ?? element.name.text, element.name.text);
          }
        }
      }
      if (importedModule === "better-sqlite3" && clause?.name) databaseConstructors.add(clause.name.text);
    }

    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const initializerText = declaration.initializer?.getText(source) ?? "";
      const isFsInitializer = /(?:require|import)\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)/.test(initializerText)
        || /^\w+\.promises$/.test(initializerText)
        || (ts.isIdentifier(declaration.initializer) && fsNamespaces.has(declaration.initializer.text));
      const isDatabaseInitializer = /(?:require|import)\s*\(\s*["']better-sqlite3["']\s*\)/.test(initializerText);
      if (ts.isIdentifier(declaration.name)) {
        if (isFsInitializer) fsNamespaces.add(declaration.name.text);
        if (isDatabaseInitializer) databaseConstructors.add(declaration.name.text);
        continue;
      }
      if (!ts.isObjectBindingPattern(declaration.name) || !isFsInitializer) continue;
      for (const element of declaration.name.elements) {
        const importedName = propertyNameText(element.propertyName) ?? propertyNameText(element.name);
        const localName = propertyNameText(element.name);
        if (importedName && localName) registerNamedBinding(importedName, localName);
      }
    }
  }
  return { fsNamespaces, directCalls, databaseConstructors };
}

function callKind(node, bindings) {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) {
    if (bindings.directCalls.has(callee.text)) return bindings.directCalls.get(callee.text);
    if (FS_METHOD_KINDS.has(callee.text)) return FS_METHOD_KINDS.get(callee.text);
    if (ATOMIC_HELPERS.has(callee.text)) return "atomic-write";
    return null;
  }
  if (!ts.isPropertyAccessExpression(callee)) return null;
  const method = callee.name.text;
  if (FS_METHOD_KINDS.has(method)) {
    const root = expressionRootName(callee.expression);
    if (root && (bindings.fsNamespaces.has(root) || /^(?:file)?handle$/i.test(root))) {
      return FS_METHOD_KINDS.get(method);
    }
  }
  if (method === "open") {
    const root = expressionRootName(callee.expression);
    const flag = node.arguments[1];
    if (root && bindings.fsNamespaces.has(root) && flag && ts.isStringLiteralLike(flag) && /[wax+]/.test(flag.text)) {
      return "write-file";
    }
  }
  if (ATOMIC_HELPERS.has(method)) return "atomic-write";
  return null;
}

function constructorKind(node, bindings) {
  const expression = node.expression;
  const name = ts.isIdentifier(expression) ? expression.text : null;
  if (!name) return null;
  if (bindings.databaseConstructors.has(name)) return "database-open";
  if (PERSISTENT_CONSTRUCTORS.has(name)) return "persistent-store-constructor";
  return null;
}

export function discoverSites(rootDir = REPOSITORY_ROOT) {
  const sites = [];
  for (const sourceFile of listSourceFiles(rootDir)) {
    const absolutePath = path.join(rootDir, sourceFile);
    const text = fs.readFileSync(absolutePath, "utf-8");
    const source = ts.createSourceFile(
      sourceFile,
      text,
      ts.ScriptTarget.Latest,
      true,
      sourceFile.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const bindings = collectBindings(source);
    const visit = (node) => {
      const kind = ts.isCallExpression(node)
        ? callKind(node, bindings)
        : (ts.isNewExpression(node) ? constructorKind(node, bindings) : null);
      if (kind) {
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const excerpt = node.getText(source).trim().replace(/\s+/g, " ").slice(0, 240);
        sites.push({ sourceFile, line, kind, excerpt, reason: "unclassified", storeId: null, exemptionId: null });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return sites.sort((a, b) => (
    a.sourceFile.localeCompare(b.sourceFile)
    || a.line - b.line
    || a.kind.localeCompare(b.kind)
    || a.excerpt.localeCompare(b.excerpt)
  ));
}

function ruleMatches(site, rule) {
  if (site.sourceFile !== rule.sourceFile) return false;
  if (rule.kinds && !rule.kinds.includes(site.kind)) return false;
  if (rule.linePattern && !new RegExp(rule.linePattern).test(site.excerpt)) return false;
  return true;
}

function validateDate(value, label, today) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD`);
  if (value < today) throw new Error(`${label} expired on ${value}`);
}

function normalizedOwnershipPattern(pattern, platform = "posix") {
  const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+/g, "/");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function segmentCompatible(left, right) {
  return left === right || /^\{[^}]+\}$/.test(left) || /^\{[^}]+\}$/.test(right);
}

function patternContains(parentPattern, childPattern, platform = "posix") {
  const parent = normalizedOwnershipPattern(parentPattern, platform).split("/");
  const child = normalizedOwnershipPattern(childPattern, platform).split("/");
  if (parent.length > child.length) return false;
  return parent.every((segment, index) => segmentCompatible(segment, child[index]));
}

function explicitlyExcludes(store, otherPattern, platform) {
  return (store.pathExclusions ?? []).some((excludedPattern) => (
    patternContains(excludedPattern, otherPattern, platform)
  ));
}

export function pathPatternsOverlap(leftStore, rightStore, platform = "posix") {
  if (explicitlyExcludes(leftStore, rightStore.pathPattern, platform)
    || explicitlyExcludes(rightStore, leftStore.pathPattern, platform)) {
    return false;
  }
  const left = normalizedOwnershipPattern(leftStore.pathPattern, platform).split("/");
  const right = normalizedOwnershipPattern(rightStore.pathPattern, platform).split("/");
  const commonLength = Math.min(left.length, right.length);
  for (let index = 0; index < commonLength; index += 1) {
    if (!segmentCompatible(left[index], right[index])) return false;
  }
  if (left.length === right.length) return true;
  if (left.length < right.length) return leftStore.pathKind === "tree";
  return rightStore.pathKind === "tree";
}

export function validateRegistry({ stores, exemptions, today = new Date().toISOString().slice(0, 10) }) {
  const storeIds = new Set();
  for (const store of stores) {
    if (storeIds.has(store.id)) throw new Error(`duplicate store id: ${store.id}`);
    storeIds.add(store.id);
    if (!Array.isArray(store.pathPatterns) || store.pathPatterns.length === 0) {
      throw new Error(`store ${store.id} has no pathPatterns`);
    }
    for (const ownershipPattern of store.pathPatterns) {
      if (path.posix.isAbsolute(ownershipPattern) || path.win32.isAbsolute(ownershipPattern)) {
        throw new Error(`store ${store.id} has an absolute pathPattern: ${ownershipPattern}`);
      }
      if (ownershipPattern.includes("\\")) {
        throw new Error(`store ${store.id} pathPattern must be POSIX-normalized: ${ownershipPattern}`);
      }
    }
    if (!Array.isArray(store.pathExclusions)) {
      throw new Error(`store ${store.id} has no pathExclusions array`);
    }
    for (const excludedPattern of store.pathExclusions) {
      if (path.posix.isAbsolute(excludedPattern) || path.win32.isAbsolute(excludedPattern)) {
        throw new Error(`store ${store.id} has an absolute pathExclusion: ${excludedPattern}`);
      }
      if (excludedPattern.includes("\\")) {
        throw new Error(`store ${store.id} pathExclusion must be POSIX-normalized: ${excludedPattern}`);
      }
      if (!store.pathPatterns.some((ownedPattern) => patternContains(ownedPattern, excludedPattern))) {
        throw new Error(`store ${store.id} pathExclusion is outside its ownership: ${excludedPattern}`);
      }
      if (store.pathPatterns.some((ownedPattern) => (
        normalizedOwnershipPattern(ownedPattern) === normalizedOwnershipPattern(excludedPattern)
      ))) {
        throw new Error(`store ${store.id} pathExclusion must be a strict child path: ${excludedPattern}`);
      }
    }
    if (store.pathPattern !== store.pathPatterns[0]) {
      throw new Error(`store ${store.id} pathPattern must equal its first pathPatterns entry`);
    }
    if (!STARTUP_PHASES.includes(store.firstPossibleOpenPhase)) {
      throw new Error(`store ${store.id} has unknown open phase: ${store.firstPossibleOpenPhase}`);
    }
    if (!STARTUP_PHASES.includes(store.firstPossibleWritePhase)) {
      throw new Error(`store ${store.id} has unknown write phase: ${store.firstPossibleWritePhase}`);
    }
    if (store.exemption) validateDate(store.exemption.expiresOn, `store ${store.id} exemption`, today);
    if (store.schemaSource.kind === "narrow-exemption") {
      validateDate(store.schemaSource.expiresOn, `store ${store.id} schema source exemption`, today);
    }
    if (store.schemaContract.kind === "exempt") {
      if (!store.schemaContract.expiresOn) throw new Error(`store ${store.id} schema exemption has no expiry`);
      validateDate(store.schemaContract.expiresOn, `store ${store.id} schema exemption`, today);
    }
  }
  for (const store of stores) {
    for (const excludedPattern of store.pathExclusions) {
      const takeoverOwners = stores.filter((candidate) => (
        candidate.id !== store.id
        && candidate.pathKind === "tree"
        && candidate.pathPatterns.some((candidatePattern) => (
          normalizedOwnershipPattern(candidatePattern) === normalizedOwnershipPattern(excludedPattern)
        ))
      ));
      if (takeoverOwners.length !== 1) {
        throw new Error(
          `store ${store.id} pathExclusion must be fully owned by exactly one tree descriptor: ${excludedPattern}`,
        );
      }
    }
  }
  for (let left = 0; left < stores.length; left += 1) {
    for (let right = left + 1; right < stores.length; right += 1) {
      for (const platform of ["posix", "win32"]) {
        for (const leftPattern of stores[left].pathPatterns) {
          for (const rightPattern of stores[right].pathPatterns) {
            if (pathPatternsOverlap(
              { ...stores[left], pathPattern: leftPattern },
              { ...stores[right], pathPattern: rightPattern },
              platform,
            )) {
              throw new Error(
                `store path ownership overlaps on ${platform}: ${stores[left].id} (${leftPattern}) and `
                + `${stores[right].id} (${rightPattern})`,
              );
            }
          }
        }
      }
    }
  }

  const exemptionIds = new Set();
  for (const exemption of exemptions) {
    if (exemptionIds.has(exemption.id)) throw new Error(`duplicate persistence exemption id: ${exemption.id}`);
    exemptionIds.add(exemption.id);
    validateDate(exemption.expiresOn, `persistence exemption ${exemption.id}`, today);
  }
}

function validateRuleCoverage(sites, stores, exemptions) {
  for (const store of stores) {
    for (const rule of store.siteRules) {
      if (!sites.some((site) => ruleMatches(site, rule))) {
        throw new Error(
          `dangling persistence rule for store ${store.id}: ${rule.sourceFile}`
          + `${rule.linePattern ? ` /${rule.linePattern}/` : ""}`,
        );
      }
    }
  }
  for (const exemption of exemptions) {
    if (!sites.some((site) => ruleMatches(site, exemption))) {
      throw new Error(`dangling persistence exemption: ${exemption.id} (${exemption.sourceFile})`);
    }
  }
}

function classifySites(sites, stores, exemptions) {
  const classified = [];
  for (const site of sites) {
    const storeMatches = stores.flatMap((store) => {
      const matchingRule = store.siteRules.find((rule) => ruleMatches(site, rule));
      return matchingRule ? [{ id: store.id, reason: matchingRule.reason }] : [];
    });
    const exemptionMatches = exemptions
      .filter((exemption) => ruleMatches(site, exemption))
      .map((exemption) => ({ id: exemption.id, reason: exemption.reason }));
    const matches = [
      ...storeMatches.map((match) => ({ type: "store", ...match })),
      ...exemptionMatches.map((match) => ({ type: "exemption", ...match })),
    ];
    if (matches.length === 0) {
      throw new Error(`unregistered persistence site: ${site.sourceFile}:${site.line} ${site.kind} ${site.excerpt}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `ambiguous persistence site: ${site.sourceFile}:${site.line} ${site.kind} matches `
        + matches.map((match) => `${match.type}:${match.id}`).join(", "),
      );
    }
    const match = matches[0];
    classified.push({
      ...site,
      reason: match.reason,
      storeId: match.type === "store" ? match.id : null,
      exemptionId: match.type === "exemption" ? match.id : null,
    });
  }
  return classified;
}

function publicStoreDescriptor(store) {
  const descriptor = { ...store };
  delete descriptor.siteRules;
  return descriptor;
}

export function buildStartupReceipt(stores) {
  const coordinatorIndex = startupPhaseIndex(FUTURE_EPOCH_COORDINATOR_PHASE);
  return {
    version: 1,
    generatedBy: "scripts/scan-persistent-stores.mjs",
    canonicalPhases: [...STARTUP_PHASES],
    futureCoordinatorPhase: FUTURE_EPOCH_COORDINATOR_PHASE,
    stores: [...stores]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((store) => {
        const openIndex = startupPhaseIndex(store.firstPossibleOpenPhase);
        const writeIndex = startupPhaseIndex(store.firstPossibleWritePhase);
        const opensBeforeFutureCoordinator = openIndex < coordinatorIndex;
        const writesBeforeFutureCoordinator = writeIndex < coordinatorIndex;
        return {
          id: store.id,
          firstPossibleOpenPhase: store.firstPossibleOpenPhase,
          firstPossibleWritePhase: store.firstPossibleWritePhase,
          opensBeforeFutureCoordinator,
          writesBeforeFutureCoordinator,
          breakingMigrationRequiresAccessMove: store.affectedByEpochMigration
            && (openIndex <= coordinatorIndex || writeIndex <= coordinatorIndex),
        };
      }),
  };
}

export function scanPersistentStores({
  rootDir = REPOSITORY_ROOT,
  stores = PERSISTENT_STORES,
  exemptions = PERSISTENCE_EXEMPTIONS,
  today = new Date().toISOString().slice(0, 10),
} = {}) {
  validateRegistry({ stores, exemptions, today });
  const discoveredSites = discoverSites(rootDir);
  validateRuleCoverage(discoveredSites, stores, exemptions);
  const sites = classifySites(discoveredSites, stores, exemptions);
  const inventory = {
    version: 1,
    generatedBy: "scripts/scan-persistent-stores.mjs",
    sourceRoots: [...PRODUCTION_ROOTS],
    stores: [...stores].sort((a, b) => a.id.localeCompare(b.id)).map(publicStoreDescriptor),
    discoveredSites: sites,
    exemptions: [...exemptions].sort((a, b) => a.id.localeCompare(b.id)),
  };
  return { inventory, startupReceipt: buildStartupReceipt(stores) };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function writeReceipts({ rootDir = REPOSITORY_ROOT, ...scanOptions } = {}) {
  const result = scanPersistentStores({ rootDir, ...scanOptions });
  const inventoryPath = path.join(rootDir, "build", "persistence-store-inventory.json");
  const startupPath = path.join(rootDir, "build", "persistence-startup-receipt.json");
  fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
  fs.writeFileSync(inventoryPath, stableJson(result.inventory), "utf-8");
  fs.writeFileSync(startupPath, stableJson(result.startupReceipt), "utf-8");
  return { ...result, inventoryPath, startupPath };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { inventory, inventoryPath, startupPath } = writeReceipts();
  process.stdout.write(
    `persistence inventory: ${inventory.stores.length} stores, ${inventory.discoveredSites.length} sites\n`
    + `${toPosix(path.relative(REPOSITORY_ROOT, inventoryPath))}\n`
    + `${toPosix(path.relative(REPOSITORY_ROOT, startupPath))}\n`,
  );
}
