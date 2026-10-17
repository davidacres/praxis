import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Sidecar protocol requires strict NDJSON on stdout; redirect console output to stderr.
const writeStdout = process.stdout.write.bind(process.stdout);
console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);
console.warn = (...args) => console.error(...args);

const PROTOCOL_VERSION = '1.0';
const ADAPTER_VERSION = 'typescript-7.0/v2';

function sha256(input) {
  return 'sha256:' + crypto.createHash('sha256').update(input).digest('hex');
}

function jsonIdentity(...parts) {
  return JSON.stringify(parts);
}

function makeId(prefix, ...parts) {
  return prefix + sha256(Buffer.from(jsonIdentity(...parts), 'utf8')).slice(7);
}

async function loadTypeScript() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [];
  if (process.env.PRAXIS_TYPESCRIPT_ROOT) {
    candidates.push(path.resolve(process.env.PRAXIS_TYPESCRIPT_ROOT));
  }
  let current = scriptDir;
  for (let i = 0; i < 12; i++) {
    candidates.push(path.join(current, 'node_modules', 'typescript'));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    const syncPath = path.join(candidate, 'dist', 'api', 'sync', 'api.js');
    const astPath = path.join(candidate, 'dist', 'ast', 'index.js');
    if (fs.existsSync(syncPath) && fs.existsSync(astPath)) {
      const syncMod = await import(pathToFileURL(syncPath).href);
      const astMod = await import(pathToFileURL(astPath).href);
      return { ...syncMod, ...astMod };
    }
  }
  throw new Error('TYPESCRIPT_SIDECAR_UNAVAILABLE: Trusted TypeScript compiler package was not found.');
}

function normalizePath(p) {
  return p.replace(/\\/g, '/');
}

function analyzeRepository(ts, request) {
  const { API, DiagnosticCategory, SymbolFlags, SyntaxKind } = ts;
  const { repositoryId, root, sources, configs } = request;
  const realRoot = fs.realpathSync(root);
  const byRelative = new Map();
  const byAbsoluteLower = new Map();
  for (const src of sources) {
    byRelative.set(src.path, src);
    const abs = path.resolve(realRoot, src.path);
    byAbsoluteLower.set(normalizePath(abs).toLowerCase(), src);
    try {
      const realAbs = fs.realpathSync(abs);
      byAbsoluteLower.set(normalizePath(realAbs).toLowerCase(), src);
    } catch {
      // File checked by caller before and after analysis.
    }
  }

  const configByRelative = new Map();
  for (const cfg of configs || []) {
    configByRelative.set(cfg.path, cfg);
  }

  const api = new API({ cwd: realRoot });
  try {
    const openProjects = (configs || []).map(c => path.resolve(realRoot, c.path));
    const openFiles = sources
      .filter(s => s.role === 'searchableSource')
      .map(s => path.resolve(realRoot, s.path));

    const snapshot = api.updateSnapshot({
      openProjects: openProjects.length > 0 ? openProjects : undefined,
      openFiles
    });

    try {
      const contextList = [];
      const contextByKey = new Map();
      const fileToContext = new Map();
      const coveredPaths = new Set();

      // 1. Configured projects from tsconfig.json / jsconfig.json
      const configuredProjects = snapshot.getProjects();
      const resolvedConfigs = [];
      for (const cfg of configs || []) {
        const absConfig = normalizePath(path.resolve(realRoot, cfg.path)).toLowerCase();
        const proj = configuredProjects.find(p => normalizePath(p.configFileName).toLowerCase() === absConfig)
          || snapshot.getProject(path.resolve(realRoot, cfg.path));
        if (!proj) continue;
        const cfgDir = path.posix.dirname(cfg.path);
        const memberPaths = new Set();
        for (const fileName of proj.program.getSourceFileNames()) {
          const matched = byAbsoluteLower.get(normalizePath(fileName).toLowerCase());
          if (matched) memberPaths.add(matched.path);
        }
        resolvedConfigs.push({ cfg, proj, cfgDir, memberPaths });
      }

      for (const { cfg, proj, cfgDir, memberPaths } of resolvedConfigs) {
        const projSources = [];
        for (const relPath of memberPaths) {
          const matched = byRelative.get(relPath);
          if (!matched) continue;
          const inThisDir = cfgDir === '.' || relPath.startsWith(cfgDir + '/');
          if (!inThisDir) {
            const ownedByOtherDir = resolvedConfigs.some(
              other =>
                other.cfg.path !== cfg.path &&
                other.memberPaths.has(relPath) &&
                (other.cfgDir === '.' || relPath.startsWith(other.cfgDir + '/'))
            );
            if (ownedByOtherDir) continue;
          } else {
            const ownedByDeeperDir = resolvedConfigs.some(
              other =>
                other.cfg.path !== cfg.path &&
                other.memberPaths.has(relPath) &&
                other.cfgDir !== '.' &&
                relPath.startsWith(other.cfgDir + '/') &&
                (cfgDir === '.' || other.cfgDir.length > cfgDir.length)
            );
            if (ownedByDeeperDir) continue;
          }
          projSources.push(matched);
          coveredPaths.add(matched.path);
        }
        if (projSources.length === 0) continue;
        projSources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

        const diags = [
          ...proj.program.getConfigFileParsingDiagnostics(),
          ...proj.program.getProgramDiagnostics(),
          ...proj.program.getSyntacticDiagnostics(),
          ...proj.program.getSemanticDiagnostics()
        ];
        const hasError = diags.some(d => d.category === DiagnosticCategory.Error);
        const resolution = hasError ? 'partial' : 'complete';
        const language = cfg.path.toLowerCase().endsWith('jsconfig.json')
          || projSources.every(s => s.language === 'javascript')
          ? 'javascript'
          : 'typescript';
        const key = cfg.path;
        const ctxId = makeId('pci:ctx:', repositoryId, key);
        const hash = sha256(
          Buffer.from(
            ADAPTER_VERSION +
              cfg.path +
              ':' +
              cfg.hash +
              '|' +
              projSources.map(s => `${s.path}:${s.hash}`).join('|'),
            'utf8'
          )
        );
        const ctx = {
          key,
          projectPath: key,
          id: ctxId,
          hash,
          resolution,
          language,
          adapterVersion: ADAPTER_VERSION,
          sources: projSources,
          project: proj,
          config: cfg,
          rawDiagnostics: diags
        };
        contextList.push(ctx);
        contextByKey.set(key, ctx);
        for (const s of projSources) {
          if (!fileToContext.has(s.path)) fileToContext.set(s.path, ctx);
        }
      }

      // 2. Uncovered or syntax-only files
      const uncoveredSources = sources
        .filter(s => s.role === 'searchableSource' && !coveredPaths.has(s.path))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      if (uncoveredSources.length > 0) {
        const key = contextList.length === 0 ? 'ts-syntax' : 'ts-uncovered-syntax';
        const ctxId = makeId('pci:ctx:', repositoryId, key);
        const language = uncoveredSources.every(s => s.language === 'javascript') ? 'javascript' : 'typescript';
        const hash = sha256(
          Buffer.from(
            ADAPTER_VERSION + key + '|' + uncoveredSources.map(s => `${s.path}:${s.hash}`).join('|'),
            'utf8'
          )
        );
        const firstAbs = path.resolve(realRoot, uncoveredSources[0].path);
        const fallbackProj = snapshot.getDefaultProjectForFile(firstAbs) || configuredProjects[0];
        const ctx = {
          key,
          projectPath: '',
          id: ctxId,
          hash,
          resolution: 'syntaxOnly',
          language,
          adapterVersion: ADAPTER_VERSION,
          sources: uncoveredSources,
          project: fallbackProj,
          config: null,
          rawDiagnostics: []
        };
        contextList.push(ctx);
        contextByKey.set(key, ctx);
        for (const s of uncoveredSources) {
          if (!fileToContext.has(s.path)) fileToContext.set(s.path, ctx);
        }
      }
      if (contextList.length > 0) {
        for (const s of sources) {
          if (!coveredPaths.has(s.path) && !fileToContext.has(s.path)) {
            contextList[0].sources.push(s);
            fileToContext.set(s.path, contextList[0]);
          }
        }
        contextList[0].sources.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      }

      const symbols = new Map();
      const projectRoots = new Map();
      const nodeToSymbolId = new Map();
      const declKeyToSymbolId = new Map();
      // Non-local source declarations by qualified name, for resolving a workspace package's
      // emitted declarations (`out/x.d.ts`) back to the source they were built from.
      const qualifiedToSymbolIds = new Map();
      const calls = [];
      const relationships = [];
      const configuredDependencies = new Map();
      const diagnostics = [];
      const interfaceOrBaseMethods = new Map(); // key: methodName -> Set<symbolId>
      const implementingMethods = new Map(); // key: interfaceMethodSymbolId -> Set<implMethodSymbolId>

      function rangeOf(sf, start, end) {
        const s = sf.getLineAndCharacterOfPosition(start);
        const e = sf.getLineAndCharacterOfPosition(end);
        return {
          start: { line: s.line, character: s.character },
          end: { line: e.line, character: e.character }
        };
      }

      function declNodeKey(filePath, pos, end, kind) {
        return `${filePath}:${pos}:${end}:${kind}`;
      }

      function isFunctionLikeInitializer(node) {
        if (!node || !node.initializer) return false;
        return (
          node.initializer.kind === SyntaxKind.ArrowFunction ||
          node.initializer.kind === SyntaxKind.FunctionExpression
        );
      }

      function isCallableNode(node) {
        if (!node) return false;
        return (
          node.kind === SyntaxKind.FunctionDeclaration ||
          node.kind === SyntaxKind.MethodDeclaration ||
          node.kind === SyntaxKind.Constructor ||
          node.kind === SyntaxKind.GetAccessor ||
          node.kind === SyntaxKind.SetAccessor ||
          node.kind === SyntaxKind.ArrowFunction ||
          node.kind === SyntaxKind.FunctionExpression
        );
      }

      function isDeclarationNode(node) {
        if (!node) return false;
        switch (node.kind) {
          case SyntaxKind.ClassDeclaration:
          case SyntaxKind.InterfaceDeclaration:
          case SyntaxKind.TypeAliasDeclaration:
          case SyntaxKind.EnumDeclaration:
          case SyntaxKind.ModuleDeclaration:
          case SyntaxKind.FunctionDeclaration:
          case SyntaxKind.MethodDeclaration:
          case SyntaxKind.MethodSignature:
          case SyntaxKind.Constructor:
          case SyntaxKind.ConstructSignature:
          case SyntaxKind.GetAccessor:
          case SyntaxKind.SetAccessor:
          case SyntaxKind.PropertyDeclaration:
          case SyntaxKind.PropertySignature:
          case SyntaxKind.EnumMember:
          case SyntaxKind.ArrowFunction:
          case SyntaxKind.FunctionExpression:
            return true;
          case SyntaxKind.VariableDeclaration: {
            return node.name && node.name.kind === SyntaxKind.Identifier;
          }
          case SyntaxKind.Parameter: {
            return (
              node.parent &&
              node.parent.kind === SyntaxKind.Constructor &&
              Array.isArray(node.modifiers) &&
              node.modifiers.length > 0 &&
              node.name &&
              node.name.kind === SyntaxKind.Identifier
            );
          }
          default:
            return false;
        }
      }

      function findEnclosingCallableNode(node) {
        let cur = node.parent;
        while (cur) {
          if (
            cur.kind === SyntaxKind.VariableDeclaration &&
            isFunctionLikeInitializer(cur) &&
            cur.initializer === node
          ) {
            cur = cur.parent;
            continue;
          }
          if (isCallableNode(cur)) return cur;
          cur = cur.parent;
        }
        return null;
      }

      function getSymbolKind(node, enclosingCallable) {
        switch (node.kind) {
          case SyntaxKind.ClassDeclaration:
          case SyntaxKind.InterfaceDeclaration:
          case SyntaxKind.TypeAliasDeclaration:
          case SyntaxKind.EnumDeclaration:
            return 'type';
          case SyntaxKind.ModuleDeclaration:
            return 'namespace';
          case SyntaxKind.Constructor:
          case SyntaxKind.ConstructSignature:
            return 'constructor';
          case SyntaxKind.GetAccessor:
          case SyntaxKind.SetAccessor:
            return 'accessor';
          case SyntaxKind.PropertyDeclaration:
          case SyntaxKind.PropertySignature:
          case SyntaxKind.EnumMember:
          case SyntaxKind.Parameter:
            return 'property';
          case SyntaxKind.MethodDeclaration:
          case SyntaxKind.MethodSignature:
            return 'method';
          case SyntaxKind.FunctionDeclaration:
            return enclosingCallable ? 'function' : 'method';
          case SyntaxKind.ArrowFunction:
          case SyntaxKind.FunctionExpression:
            return 'function';
          case SyntaxKind.VariableDeclaration:
            if (enclosingCallable) return null; // Local variables are not indexed as top-level symbols
            return isFunctionLikeInitializer(node) ? 'method' : 'field';
          default:
            return 'field';
        }
      }

      function formatParameters(sf, params, checker) {
        if (!params || params.length === 0) return '()';
        const parts = params.map(p => {
          const name = p.name ? p.name.getText(sf) : 'arg';
          const rest = p.dotDotDotToken ? '...' : '';
          const opt = p.questionToken ? '?' : '';
          let typeText = 'any';
          if (p.type) {
            typeText = p.type.getText(sf).trim();
          } else if (checker && p.name) {
            try {
              const sym = checker.getSymbolAtLocation(p.name);
              const t = sym && checker.getTypeOfSymbol(sym);
              if (t) typeText = checker.typeToString(t);
            } catch {
              // Keep fallback
            }
          }
          return `${rest}${name}${opt}: ${typeText}`;
        });
        return `(${parts.join(', ')})`;
      }

      function formatSignature(sf, node, qualifiedName, kind, checker) {
        const typeParams =
          node.typeParameters && node.typeParameters.length > 0
            ? `<${node.typeParameters.map(tp => tp.getText(sf)).join(', ')}>`
            : '';
        if (
          node.kind === SyntaxKind.FunctionDeclaration ||
          node.kind === SyntaxKind.MethodDeclaration ||
          node.kind === SyntaxKind.MethodSignature ||
          node.kind === SyntaxKind.Constructor ||
          node.kind === SyntaxKind.ConstructSignature ||
          node.kind === SyntaxKind.ArrowFunction ||
          node.kind === SyntaxKind.FunctionExpression
        ) {
          const params = formatParameters(sf, node.parameters, checker);
          let ret = '';
          if (node.type) {
            ret = `: ${node.type.getText(sf).trim()}`;
          } else if (checker) {
            try {
              const sig = checker.getSignatureFromDeclaration(node);
              const rt = sig && checker.getReturnTypeOfSignature(sig);
              if (rt) ret = `: ${checker.typeToString(rt)}`;
            } catch {
              // Ignore
            }
          }
          return `${qualifiedName}${typeParams}${params}${ret}`;
        }
        if (node.kind === SyntaxKind.VariableDeclaration && isFunctionLikeInitializer(node)) {
          return formatSignature(sf, node.initializer, qualifiedName, kind, checker);
        }
        if (
          node.kind === SyntaxKind.PropertyDeclaration ||
          node.kind === SyntaxKind.PropertySignature ||
          node.kind === SyntaxKind.VariableDeclaration
        ) {
          let typeText = '';
          if (node.type) {
            typeText = `: ${node.type.getText(sf).trim()}`;
          } else if (checker && node.name) {
            try {
              const sym = checker.getSymbolAtLocation(node.name);
              const t = sym && checker.getTypeOfSymbol(sym);
              if (t) typeText = `: ${checker.typeToString(t)}`;
            } catch {
              // Ignore
            }
          }
          return `${qualifiedName}${typeText}`;
        }
        return `${kind} ${qualifiedName}${typeParams}`;
      }

      function addSymbolLocation(symbolObj, location, contextHash, nodeText) {
        if (symbolObj.locations.some(l => l.id === location.id)) return;
        symbolObj.locations.push(location);
        const revInput = nodeText + contextHash;
        const nextRev = sha256(Buffer.from(revInput, 'utf8'));
        symbolObj.revision =
          symbolObj.locations.length === 1
            ? nextRev
            : sha256(Buffer.from(symbolObj.revision + nextRev, 'utf8'));
      }

      // Pass 1: Collect declarations per context
      for (const ctx of contextList) {
        const rootIdentity = jsonIdentity(1, 'synthetic', repositoryId, ctx.id, 'projectRoot');
        const rootId = makeId(ctx.resolution === 'syntaxOnly' ? 'pci:syntactic:' : 'pci:sym:', rootIdentity);
        projectRoots.set(ctx.id, rootId);
        symbols.set(rootId, {
          id: rootId,
          identity: rootIdentity,
          contextId: ctx.id,
          kind: 'module',
          name: '[synthetic projectRoot]',
          qualifiedName: `${ctx.key} [synthetic projectRoot]`,
          signature: '[synthetic projectRoot]',
          revision: ctx.hash,
          resolution: ctx.resolution === 'syntaxOnly' ? 'syntaxOnly' : 'resolved',
          containerId: null,
          external: false,
          documentation: 'Synthetic context containment root; not a source declaration.',
          locations: []
        });

        const checker = ctx.resolution === 'syntaxOnly' ? null : ctx.project?.checker;

        for (const source of ctx.sources) {
          if (source.role === 'semanticSupport') continue;
          const absPath = path.resolve(realRoot, source.path);
          const sf = ctx.project?.program.getSourceFile(absPath);
          if (!sf) continue;

          nodeToSymbolId.set(sf, rootId);
          const moduleQualifier = source.path.replace(/\.(d\.ts|tsx|ts|mts|cts|jsx|js|mjs|cjs)$/i, '');

          // Check for top-level executable statements or variable initializers
          const topStatements = sf.statements.filter(
            st =>
              st.kind !== SyntaxKind.InterfaceDeclaration &&
              st.kind !== SyntaxKind.TypeAliasDeclaration &&
              st.kind !== SyntaxKind.ImportDeclaration &&
              st.kind !== SyntaxKind.ExportDeclaration
          );
          let topEntryId = rootId;
          if (topStatements.length > 0) {
            const firstStart = topStatements[0].getStart(sf);
            const lastEnd = topStatements[topStatements.length - 1].getEnd();
            const entryIdentity = jsonIdentity(1, 'synthetic', repositoryId, ctx.id, source.path, 'topLevelEntry');
            topEntryId = makeId(ctx.resolution === 'syntaxOnly' ? 'pci:syntactic:' : 'pci:sym:', entryIdentity);
            const locId = makeId('pci:loc:', topEntryId, source.hash, firstStart, lastEnd);
            symbols.set(topEntryId, {
              id: topEntryId,
              identity: entryIdentity,
              contextId: ctx.id,
              kind: 'method',
              name: '[synthetic top-level entry]',
              qualifiedName: `${source.path} [synthetic top-level entry]`,
              signature: '[synthetic top-level entry]',
              revision: source.hash,
              resolution: ctx.resolution === 'syntaxOnly' ? 'syntaxOnly' : 'resolved',
              containerId: rootId,
              external: false,
              documentation: 'Synthetic module-level owner for top-level statements and initializers.',
              locations: [
                {
                  id: locId,
                  contextId: ctx.id,
                  filePath: source.path,
                  hash: source.hash,
                  start: firstStart,
                  end: lastEnd,
                  range: rangeOf(sf, firstStart, lastEnd)
                }
              ]
            });
          }

          // Track overload declarations in each scope so overload signatures associate with their implementation
          const pendingOverloads = new Map(); // key: containerId + ":" + name -> symbolObj[]
          const localOrdinals = new Map(); // key: parentSymbolId -> nextOrdinal

          function visitDeclarations(node, containerId, qualifierChain) {
            if (!isDeclarationNode(node)) {
              node.forEachChild(child => visitDeclarations(child, containerId, qualifierChain));
              return;
            }

            // Skip ArrowFunction / FunctionExpression when it is the direct initializer of a top-level/member VariableDeclaration
            if (
              (node.kind === SyntaxKind.ArrowFunction || node.kind === SyntaxKind.FunctionExpression) &&
              node.parent &&
              node.parent.kind === SyntaxKind.VariableDeclaration &&
              !findEnclosingCallableNode(node.parent)
            ) {
              node.forEachChild(child => visitDeclarations(child, containerId, qualifierChain));
              return;
            }

            const enclosingCallable = findEnclosingCallableNode(node);
            const kind = getSymbolKind(node, enclosingCallable);
            if (!kind) {
              node.forEachChild(child => visitDeclarations(child, containerId, qualifierChain));
              return;
            }

            const start = node.getStart(sf);
            const end = node.getEnd();
            let rawName =
              node.kind === SyntaxKind.Constructor || node.kind === SyntaxKind.ConstructSignature
                ? 'constructor'
                : node.name
                  ? node.name.getText(sf)
                  : '<anonymous>';

            let effectiveContainerId = containerId;
            let effectiveQualifierChain = qualifierChain;
            if (
              node.kind === SyntaxKind.Parameter &&
              node.parent &&
              node.parent.kind === SyntaxKind.Constructor &&
              node.parent.parent &&
              (node.parent.parent.kind === SyntaxKind.ClassDeclaration ||
                node.parent.parent.kind === SyntaxKind.ClassExpression)
            ) {
              const clsSymId = nodeToSymbolId.get(node.parent.parent);
              const clsSym = clsSymId && symbols.get(clsSymId);
              if (clsSym) {
                effectiveContainerId = clsSym.id;
                effectiveQualifierChain = clsSym.qualifiedName;
              }
            }

            let descriptor;
            let qualifiedName;
            if (kind === 'function') {
              const parentSymId =
                (enclosingCallable && nodeToSymbolId.get(enclosingCallable)) || topEntryId || rootId;
              const ord = localOrdinals.get(parentSymId) || 0;
              localOrdinals.set(parentSymId, ord + 1);
              descriptor = jsonIdentity('local', parentSymId, node.kind, ord);
              qualifiedName = `${effectiveQualifierChain}.${rawName}#${ord}`;
            } else {
              qualifiedName = `${effectiveQualifierChain}.${rawName}`;
              let disambiguator = '';
              if (
                node.kind === SyntaxKind.FunctionDeclaration ||
                node.kind === SyntaxKind.MethodDeclaration ||
                node.kind === SyntaxKind.MethodSignature ||
                node.kind === SyntaxKind.Constructor ||
                node.kind === SyntaxKind.ConstructSignature
              ) {
                const paramSig = (node.parameters || [])
                  .map(p => (p.type ? p.type.getText(sf).trim() : 'any'))
                  .join(',');
                disambiguator = `(${paramSig})`;
              } else if (node.kind === SyntaxKind.GetAccessor) {
                disambiguator = 'get';
              } else if (node.kind === SyntaxKind.SetAccessor) {
                disambiguator = 'set';
              }
              descriptor = disambiguator ? `${qualifiedName}${disambiguator}` : qualifiedName;
            }

            // If this is a function/method implementation (has body) and there were preceding overload signatures with the same name in this container:
            const overloadKey = `${effectiveContainerId}:${rawName}`;
            const isOverloadSignature =
              (node.kind === SyntaxKind.FunctionDeclaration || node.kind === SyntaxKind.MethodDeclaration) &&
              !node.body;
            const isOverloadImplementation =
              (node.kind === SyntaxKind.FunctionDeclaration || node.kind === SyntaxKind.MethodDeclaration) &&
              Boolean(node.body) &&
              pendingOverloads.has(overloadKey);

            const identity = jsonIdentity(
              1,
              'source',
              repositoryId,
              ctx.key,
              ctx.id,
              source.language,
              kind,
              descriptor
            );
            const symId = makeId(ctx.resolution === 'syntaxOnly' ? 'pci:syntactic:' : 'pci:sym:', identity);
            const locId = makeId('pci:loc:', symId, ctx.id, source.path, source.hash, start, end);
            const location = {
              id: locId,
              contextId: ctx.id,
              filePath: source.path,
              hash: source.hash,
              start,
              end,
              range: rangeOf(sf, start, end)
            };

            let doc = '';
            if (checker && node.name) {
              try {
                const tsSym = checker.getSymbolAtLocation(node.name);
                if (tsSym) doc = tsSym.getDocumentationComment(checker) || '';
              } catch {
                // Ignore
              }
            }

            const sigText = formatSignature(sf, node, qualifiedName, kind, checker);
            const nodeText = sf.text.slice(start, end);
            let symObj = symbols.get(symId);
            if (!symObj) {
              symObj = {
                id: symId,
                identity,
                contextId: ctx.id,
                kind,
                name: rawName,
                qualifiedName,
                signature: sigText,
                revision: sha256(Buffer.from(nodeText + ctx.hash, 'utf8')),
                resolution: ctx.resolution === 'syntaxOnly' ? 'syntaxOnly' : 'resolved',
                containerId: effectiveContainerId,
                external: false,
                documentation: doc,
                locations: [location]
              };
              symbols.set(symId, symObj);
              if (kind !== 'function' || !enclosingCallable) {
                const same = qualifiedToSymbolIds.get(qualifiedName) || [];
                same.push(symId);
                qualifiedToSymbolIds.set(qualifiedName, same);
              }
            } else {
              if (symObj.identity !== identity) {
                throw new Error('IDENTITY_COLLISION');
              }
              addSymbolLocation(symObj, location, ctx.hash, nodeText);
            }

            if (isOverloadSignature) {
              const list = pendingOverloads.get(overloadKey) || [];
              list.push(symObj);
              pendingOverloads.set(overloadKey, list);
            } else if (isOverloadImplementation) {
              // Associate implementation location with each overload signature (§26.3)
              for (const ovSym of pendingOverloads.get(overloadKey) || []) {
                const implLocId = makeId('pci:loc:', ovSym.id, ctx.id, source.path, source.hash, start, end);
                addSymbolLocation(
                  ovSym,
                  { ...location, id: implLocId },
                  ctx.hash,
                  nodeText
                );
              }
              pendingOverloads.delete(overloadKey);
            }

            nodeToSymbolId.set(node, symId);
            if (node.kind === SyntaxKind.VariableDeclaration && isFunctionLikeInitializer(node)) {
              nodeToSymbolId.set(node.initializer, symId);
            }
            declKeyToSymbolId.set(declNodeKey(source.path, start, end, node.kind), symId);
            if (node.name) {
              declKeyToSymbolId.set(
                declNodeKey(source.path, node.name.getStart(sf), node.name.getEnd(), node.name.kind),
                symId
              );
            }

            if (
              node.kind === SyntaxKind.MethodSignature ||
              (node.kind === SyntaxKind.MethodDeclaration &&
                node.parent &&
                node.parent.kind === SyntaxKind.ClassDeclaration)
            ) {
              const set = interfaceOrBaseMethods.get(rawName) || new Set();
              set.add(symId);
              interfaceOrBaseMethods.set(rawName, set);
            }

            const nextContainer = symId;
            const nextQualifier = qualifiedName;
            node.forEachChild(child => visitDeclarations(child, nextContainer, nextQualifier));
          }

          sf.forEachChild(child => visitDeclarations(child, rootId, moduleQualifier));
        }
      }

      const repoRootLower = normalizePath(realRoot).toLowerCase();

      // Where each configured project emits declarations, and the source root they come from.
      // Monorepo packages are imported through their built `types` entry (e.g. `out/index.d.ts`),
      // so without this every cross-package call would resolve to an external placeholder.
      const declarationOutputs = [];
      for (const { cfg, proj } of resolvedConfigs) {
        const options = proj.compilerOptions || {};
        const cfgDirAbs = path.resolve(realRoot, path.posix.dirname(cfg.path));
        const output = options.declarationDir || options.outDir;
        if (!output) continue;
        const outputAbs = normalizePath(path.resolve(cfgDirAbs, output)).toLowerCase();
        const rootAbs = normalizePath(path.resolve(cfgDirAbs, options.rootDir || '.'));
        if (outputAbs === rootAbs.toLowerCase()) continue;
        declarationOutputs.push({ outputAbs, rootAbs });
      }

      function sourceForDeclarationOutput(declarationPath) {
        let real = declarationPath;
        try { real = fs.realpathSync(declarationPath); } catch { /* keep the reported path */ }
        const normalized = normalizePath(real);
        const lower = normalized.toLowerCase();
        const match = lower.match(/\.d\.(m|c)?ts$/);
        if (!match) return null;
        for (const { outputAbs, rootAbs } of declarationOutputs) {
          if (!lower.startsWith(outputAbs + '/')) continue;
          const relative = normalized.slice(outputAbs.length + 1, normalized.length - match[0].length);
          const extensions = match[1] === 'm' ? ['.mts'] : match[1] === 'c' ? ['.cts'] : ['.ts', '.tsx', '.js', '.jsx'];
          for (const extension of extensions) {
            const source = byAbsoluteLower.get(`${rootAbs}/${relative}${extension}`.toLowerCase());
            if (source && source.role === 'searchableSource') return source;
          }
        }
        return null;
      }

      // The declaration's name path inside its file: `Class.method`, `namespace.fn`, `config.key`.
      function declarationNamePath(node) {
        const names = [];
        for (let current = node; current && current.kind !== SyntaxKind.SourceFile; current = current.parent) {
          if (current.kind === SyntaxKind.Constructor) names.push('constructor');
          else if (current.name && current.name.kind === SyntaxKind.Identifier) names.push(current.name.text ?? current.name.escapedText);
        }
        return names.reverse().join('.');
      }

      function resolveFromDeclarationOutput(ctx, handles) {
        for (const handle of handles) {
          if (!handle || !handle.path) continue;
          const source = sourceForDeclarationOutput(handle.path);
          if (!source) continue;
          const node = typeof handle.resolve === 'function' ? handle.resolve(ctx.project) : null;
          if (!node) continue;
          const namePath = declarationNamePath(node);
          if (!namePath) continue;
          const moduleQualifier = source.path.replace(/\.(d\.ts|tsx|ts|mts|cts|jsx|js|mjs|cjs)$/i, '');
          const ids = qualifiedToSymbolIds.get(`${moduleQualifier}.${namePath}`);
          if (!ids || ids.length === 0) continue;
          const targetCtx = fileToContext.get(source.path);
          return { id: ids[0], contextId: targetCtx ? targetCtx.id : ctx.id, external: false };
        }
        return null;
      }

      function resolveTargetSymbol(ctx, tsSym, declNode, preferredKind = 'method') {
        if (!tsSym && !declNode) return null;
        const checker = ctx.project?.checker;
        let resolvedSym = tsSym;
        if (checker && resolvedSym && (resolvedSym.flags & SymbolFlags.Alias) !== 0) {
          try {
            const aliased = checker.getAliasedSymbol(resolvedSym);
            if (aliased && !checker.isUnknownSymbol(aliased)) resolvedSym = aliased;
          } catch {
            // Keep original symbol
          }
        }

        const candidateHandles = [];
        if (declNode && declNode.path && typeof declNode.resolve === 'function') {
          candidateHandles.push(declNode);
        }
        if (resolvedSym) {
          if (resolvedSym.valueDeclaration) candidateHandles.push(resolvedSym.valueDeclaration);
          if (resolvedSym.declarations) candidateHandles.push(...resolvedSym.declarations);
        }

        for (const handle of candidateHandles) {
          const matchedSource = byAbsoluteLower.get(normalizePath(handle.path).toLowerCase());
          if (matchedSource && matchedSource.role === 'searchableSource') {
            const targetCtx = fileToContext.get(matchedSource.path) || ctx;
            const resolvedNode = handle.resolve(targetCtx.project) || handle.resolve(ctx.project);
            if (resolvedNode) {
              const directId = nodeToSymbolId.get(resolvedNode);
              if (directId) return { id: directId, contextId: targetCtx.id, external: false };
              const targetSf = resolvedNode.getSourceFile();
              const k = declNodeKey(
                matchedSource.path,
                resolvedNode.getStart(targetSf),
                resolvedNode.getEnd(),
                resolvedNode.kind
              );
              const byKey = declKeyToSymbolId.get(k);
              if (byKey) return { id: byKey, contextId: targetCtx.id, external: false };
            }
          }
        }

        const fromOutput = resolveFromDeclarationOutput(ctx, candidateHandles);
        if (fromOutput) return fromOutput;

        // External declaration (e.g., node_modules / lib.d.ts / semanticSupport)
        if (resolvedSym && resolvedSym.name && resolvedSym.name !== 'unknown') {
          const firstDecl = candidateHandles[0];
          const extPath = firstDecl ? normalizePath(firstDecl.path) : 'global';
          const extLower = extPath.toLowerCase();
          const isInRepoNodeModules = extLower.startsWith(`${repoRootLower}/node_modules/`);
          const pkgMatch = isInRepoNodeModules
            ? extPath.slice(repoRootLower.length).match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)/i)
            : null;
          const referenceIdentity = pkgMatch ? `npm:${pkgMatch[1]}` : 'ts:defaultLib';
          const extIdentity = jsonIdentity(
            1,
            'external',
            repositoryId,
            ctx.language,
            referenceIdentity,
            preferredKind,
            `${referenceIdentity}:${resolvedSym.name}`
          );
          const extId = makeId('pci:sym:', extIdentity);
          if (!symbols.has(extId)) {
            symbols.set(extId, {
              id: extId,
              identity: extIdentity,
              contextId: '',
              kind: preferredKind,
              name: resolvedSym.name,
              qualifiedName: `${referenceIdentity}/${resolvedSym.name}`,
              signature: `external ${preferredKind} ${resolvedSym.name}`,
              revision: sha256(Buffer.from(extIdentity, 'utf8')),
              resolution: 'resolved',
              containerId: null,
              external: true,
              documentation: '',
              locations: []
            });
          }
          return { id: extId, contextId: null, external: true };
        }
        return null;
      }

      // Pass 2: Collect calls, relationships, dependencies, and diagnostics
      const observedCrossProject = new Set();

      for (const ctx of contextList) {
        const rootId = projectRoots.get(ctx.id);
        const checker = ctx.resolution === 'syntaxOnly' ? null : ctx.project?.checker;
        const syntaxOnly = ctx.resolution === 'syntaxOnly';

        // Configured project references from tsconfig.json
        if (ctx.config && Array.isArray(ctx.config.references)) {
          for (const refPath of ctx.config.references) {
            const targetCtx = contextByKey.get(refPath);
            if (!targetCtx) continue;
            const targetRootId = projectRoots.get(targetCtx.id);
            const depIdentity = jsonIdentity('compilerReference', 'project', ctx.id, ctx.hash, targetCtx.id, targetCtx.hash);
            const depId = makeId('pci:dependency:', depIdentity);
            configuredDependencies.set(depId, {
              id: depId,
              contextId: ctx.id,
              ownerId: rootId,
              targetId: targetRootId,
              inputRevision: ctx.hash,
              resolution: ctx.resolution === 'complete' && targetCtx.resolution === 'complete' ? 'resolved' : 'possible',
              referenceIdentity: depIdentity,
              targetContextId: targetCtx.id,
              requiredContextHash: targetCtx.hash
            });
          }
        }

        // Compiler diagnostics for configured contexts
        for (const diag of ctx.rawDiagnostics || []) {
          let diagPath = null;
          let diagRange = null;
          if (diag.fileName) {
            const matched = byAbsoluteLower.get(normalizePath(diag.fileName).toLowerCase());
            if (matched && matched.role === 'searchableSource') {
              diagPath = matched.path;
              const sf = ctx.project?.program.getSourceFile(diag.fileName);
              if (sf && typeof diag.pos === 'number' && typeof diag.end === 'number') {
                diagRange = rangeOf(sf, diag.pos, Math.max(diag.pos, diag.end));
              }
            }
          }
          const severity =
            diag.category === DiagnosticCategory.Error
              ? 'error'
              : diag.category === DiagnosticCategory.Warning
                ? 'warning'
                : 'info';
          diagnostics.push({
            contextId: ctx.id,
            filePath: diagPath,
            code: `TS${diag.code || 0}`,
            severity,
            message: diag.text || 'TypeScript diagnostic',
            range: diagRange
          });
        }

        for (const source of ctx.sources) {
          if (source.role === 'semanticSupport') continue;
          const absPath = path.resolve(realRoot, source.path);
          const sf = ctx.project?.program.getSourceFile(absPath);
          if (!sf) continue;

          // Find synthetic top-level entry for this file if present
          const entryIdentity = jsonIdentity(1, 'synthetic', repositoryId, ctx.id, source.path, 'topLevelEntry');
          const entryCandidateId = makeId(syntaxOnly ? 'pci:syntactic:' : 'pci:sym:', entryIdentity);
          const defaultOwnerId = symbols.has(entryCandidateId) ? entryCandidateId : rootId;

          function currentOwner(node) {
            let cur = node;
            while (cur) {
              if (cur !== sf && nodeToSymbolId.has(cur)) return nodeToSymbolId.get(cur);
              cur = cur.parent;
            }
            return defaultOwnerId;
          }

          function recordCrossProjectDependency(targetResolved, start, end, range) {
            if (
              !targetResolved ||
              targetResolved.external ||
              !targetResolved.contextId ||
              targetResolved.contextId === ctx.id
            ) {
              return;
            }
            const targetRootId = projectRoots.get(targetResolved.contextId);
            if (!targetRootId) return;
            const pairKey = `${ctx.id}->${targetResolved.contextId}:${source.path}:${start}:${end}`;
            if (observedCrossProject.has(pairKey)) return;
            observedCrossProject.add(pairKey);
            const occId = makeId('pci:occ:', ctx.id, source.path, source.hash, start, end, 'depends_on', targetRootId);
            relationships.push({
              id: occId,
              contextId: ctx.id,
              filePath: source.path,
              hash: source.hash,
              ownerId: rootId,
              targetId: targetRootId,
              start,
              end,
              range,
              resolution: ctx.resolution === 'complete' ? 'resolved' : 'possible',
              kind: 'depends_on'
            });
          }

          function walk(node) {
            const start = node.getStart(sf);
            const end = node.getEnd();
            const range = rangeOf(sf, start, end);
            const ownerId = currentOwner(node);

            // 1. Calls and NewExpressions
            if (node.kind === SyntaxKind.CallExpression || node.kind === SyntaxKind.NewExpression) {
              let target = null;
              if (checker) {
                try {
                  const sig = checker.getResolvedSignature(node);
                  const calleeSym = node.expression ? checker.getSymbolAtLocation(node.expression) : null;
                  target = resolveTargetSymbol(
                    ctx,
                    calleeSym,
                    sig?.declaration,
                    node.kind === SyntaxKind.NewExpression ? 'constructor' : 'method'
                  );
                } catch {
                  // Fallback below
                }
              }
              const resolution = syntaxOnly ? 'syntaxOnly' : target ? 'resolved' : 'unresolved';
              const callId = makeId('pci:call:', ctx.id, source.path, source.hash, start, end, target?.id || 'unresolved');
              calls.push({
                id: callId,
                contextId: ctx.id,
                filePath: source.path,
                hash: source.hash,
                ownerId,
                targetId: target ? target.id : null,
                start,
                end,
                range,
                resolution,
                kind: 'calls'
              });
              if (target) {
                recordCrossProjectDependency(target, start, end, range);
                const impls = implementingMethods.get(target.id);
                if (impls) {
                  for (const implId of impls) {
                    if (implId === target.id) continue;
                    const mayId = makeId('pci:call:', ctx.id, source.path, source.hash, start, end, 'may_call', implId);
                    calls.push({
                      id: mayId,
                      contextId: ctx.id,
                      filePath: source.path,
                      hash: source.hash,
                      ownerId,
                      targetId: implId,
                      start,
                      end,
                      range,
                      resolution: 'possible',
                      kind: 'may_call'
                    });
                  }
                }
              }
            }

            // 1b. JSX elements: rendering <Component /> calls the component, so `get_callers`
            // answers "where is this rendered". Intrinsic elements (<div>) are not symbols.
            if (
              (node.kind === SyntaxKind.JsxOpeningElement || node.kind === SyntaxKind.JsxSelfClosingElement) &&
              node.tagName &&
              !(node.tagName.kind === SyntaxKind.Identifier && /^[a-z]/.test(node.tagName.getText(sf)))
            ) {
              let target = null;
              if (checker) {
                try { target = resolveTargetSymbol(ctx, checker.getSymbolAtLocation(node.tagName), null, 'method'); }
                catch { /* recorded as unresolved */ }
              }
              const tagStart = node.tagName.getStart(sf);
              const tagEnd = node.tagName.getEnd();
              const tagRange = rangeOf(sf, tagStart, tagEnd);
              calls.push({
                id: makeId('pci:call:', ctx.id, source.path, source.hash, tagStart, tagEnd, target?.id || 'unresolved'),
                contextId: ctx.id,
                filePath: source.path,
                hash: source.hash,
                ownerId,
                targetId: target ? target.id : null,
                start: tagStart,
                end: tagEnd,
                range: tagRange,
                resolution: syntaxOnly ? 'syntaxOnly' : target ? 'resolved' : 'unresolved',
                kind: 'calls'
              });
              if (target) recordCrossProjectDependency(target, tagStart, tagEnd, tagRange);
            }

            // 2. Heritage clauses (extends / implements)
            if (
              (node.kind === SyntaxKind.ClassDeclaration || node.kind === SyntaxKind.InterfaceDeclaration) &&
              node.heritageClauses &&
              checker
            ) {
              const classSymId = nodeToSymbolId.get(node);
              if (classSymId) {
                for (const hc of node.heritageClauses) {
                  const isImplements = hc.token === SyntaxKind.ImplementsKeyword;
                  const relKind = isImplements ? 'implements' : 'inherits';
                  for (const typeNode of hc.types || []) {
                    try {
                      const tsSym =
                        checker.getSymbolAtLocation(typeNode.expression) ||
                        checker.getTypeAtLocation(typeNode)?.getSymbol();
                      const target = resolveTargetSymbol(ctx, tsSym, null, 'type');
                      if (target) {
                        const tStart = typeNode.getStart(sf);
                        const tEnd = typeNode.getEnd();
                        const tRange = rangeOf(sf, tStart, tEnd);
                        const occId = makeId('pci:occ:', ctx.id, source.path, source.hash, tStart, tEnd, relKind, target.id);
                        relationships.push({
                          id: occId,
                          contextId: ctx.id,
                          filePath: source.path,
                          hash: source.hash,
                          ownerId: classSymId,
                          targetId: target.id,
                          start: tStart,
                          end: tEnd,
                          range: tRange,
                          resolution: 'resolved',
                          kind: relKind
                        });
                        recordCrossProjectDependency(target, tStart, tEnd, tRange);

                        // Also link matching member methods on this class to members on the base/interface type
                        const targetSymObj = symbols.get(target.id);
                        if (targetSymObj && !target.external) {
                          for (const member of node.members || []) {
                            const memberSymId = nodeToSymbolId.get(member);
                            const memberName = member.name ? member.name.getText(sf) : null;
                            if (!memberSymId || !memberName) continue;
                            for (const candidateId of interfaceOrBaseMethods.get(memberName) || []) {
                              const cand = symbols.get(candidateId);
                              if (cand && cand.containerId === target.id && cand.id !== memberSymId) {
                                const mStart = member.getStart(sf);
                                const mEnd = member.getEnd();
                                const mEdgeKind = isImplements ? 'implements' : 'overrides';
                                const mOccId = makeId(
                                  'pci:occ:',
                                  ctx.id,
                                  source.path,
                                  source.hash,
                                  mStart,
                                  mEnd,
                                  mEdgeKind,
                                  cand.id
                                );
                                relationships.push({
                                  id: mOccId,
                                  contextId: ctx.id,
                                  filePath: source.path,
                                  hash: source.hash,
                                  ownerId: memberSymId,
                                  targetId: cand.id,
                                  start: mStart,
                                  end: mEnd,
                                  range: rangeOf(sf, mStart, mEnd),
                                  resolution: 'resolved',
                                  kind: mEdgeKind
                                });
                                const set = implementingMethods.get(cand.id) || new Set();
                                set.add(memberSymId);
                                implementingMethods.set(cand.id, set);
                              }
                            }
                          }
                        }
                      }
                    } catch {
                      // Ignore unresolved heritage
                    }
                  }
                }
              }
            }

            // 3. Throw statements
            if (node.kind === SyntaxKind.ThrowStatement && node.expression && checker) {
              try {
                let thrownSym = null;
                if (node.expression.kind === SyntaxKind.NewExpression && node.expression.expression) {
                  thrownSym = checker.getSymbolAtLocation(node.expression.expression);
                }
                if (!thrownSym) {
                  const thrownType = checker.getTypeAtLocation(node.expression);
                  thrownSym = thrownType?.getSymbol();
                }
                const target = resolveTargetSymbol(ctx, thrownSym, null, 'type');
                if (target) {
                  const occId = makeId('pci:occ:', ctx.id, source.path, source.hash, start, end, 'throws', target.id);
                  relationships.push({
                    id: occId,
                    contextId: ctx.id,
                    filePath: source.path,
                    hash: source.hash,
                    ownerId,
                    targetId: target.id,
                    start,
                    end,
                    range,
                    resolution: 'resolved',
                    kind: 'throws'
                  });
                }
              } catch {
                // Ignore
              }
            }

            // 4. Import declarations
            if (node.kind === SyntaxKind.ImportDeclaration && checker) {
              const clause = node.importClause;
              const bindings = [];
              if (clause) {
                if (clause.name) bindings.push(clause.name);
                if (clause.namedBindings) {
                  if (clause.namedBindings.name) bindings.push(clause.namedBindings.name);
                  if (clause.namedBindings.elements) {
                    for (const el of clause.namedBindings.elements) {
                      if (el.name) bindings.push(el.name);
                    }
                  }
                }
              }
              for (const b of bindings) {
                try {
                  const tsSym = checker.getSymbolAtLocation(b);
                  const target = resolveTargetSymbol(ctx, tsSym, null, 'type');
                  if (target) {
                    const bStart = b.getStart(sf);
                    const bEnd = b.getEnd();
                    const bRange = rangeOf(sf, bStart, bEnd);
                    const occId = makeId('pci:occ:', ctx.id, source.path, source.hash, bStart, bEnd, 'imports', target.id);
                    relationships.push({
                      id: occId,
                      contextId: ctx.id,
                      filePath: source.path,
                      hash: source.hash,
                      ownerId: rootId,
                      targetId: target.id,
                      start: bStart,
                      end: bEnd,
                      range: bRange,
                      resolution: 'resolved',
                      kind: 'imports'
                    });
                    recordCrossProjectDependency(target, bStart, bEnd, bRange);
                  }
                } catch {
                  // Ignore
                }
              }
            }

            // 5. Type references
            if (node.kind === SyntaxKind.TypeReference && node.typeName && checker) {
              try {
                const tsSym = checker.getSymbolAtLocation(node.typeName);
                const target = resolveTargetSymbol(ctx, tsSym, null, 'type');
                if (target) {
                  const occId = makeId('pci:occ:', ctx.id, source.path, source.hash, start, end, 'references', target.id);
                  relationships.push({
                    id: occId,
                    contextId: ctx.id,
                    filePath: source.path,
                    hash: source.hash,
                    ownerId,
                    targetId: target.id,
                    start,
                    end,
                    range,
                    resolution: 'resolved',
                    kind: 'references'
                  });
                  recordCrossProjectDependency(target, start, end, range);
                }
              } catch {
                // Ignore
              }
            }

            // 6. Property/field reads & writes
            if (node.kind === SyntaxKind.PropertyAccessExpression && checker) {
              // Skip if this PropertyAccessExpression is the callee of a CallExpression
              const isCallee =
                node.parent &&
                (node.parent.kind === SyntaxKind.CallExpression || node.parent.kind === SyntaxKind.NewExpression) &&
                node.parent.expression === node;
              if (!isCallee && node.name) {
                try {
                  const tsSym = checker.getSymbolAtLocation(node.name);
                  const target = resolveTargetSymbol(ctx, tsSym, null, 'property');
                  if (target) {
                    const parent = node.parent;
                    const isWrite =
                      (parent &&
                        parent.kind === SyntaxKind.BinaryExpression &&
                        parent.left === node &&
                        parent.operatorToken &&
                        parent.operatorToken.kind >= SyntaxKind.FirstAssignment &&
                        parent.operatorToken.kind <= SyntaxKind.LastAssignment) ||
                      (parent &&
                        (parent.kind === SyntaxKind.PrefixUnaryExpression ||
                          parent.kind === SyntaxKind.PostfixUnaryExpression));
                    const isCompound =
                      (parent &&
                        parent.kind === SyntaxKind.BinaryExpression &&
                        parent.left === node &&
                        parent.operatorToken &&
                        parent.operatorToken.kind > SyntaxKind.EqualsToken &&
                        parent.operatorToken.kind <= SyntaxKind.LastAssignment) ||
                      (parent &&
                        (parent.kind === SyntaxKind.PrefixUnaryExpression ||
                          parent.kind === SyntaxKind.PostfixUnaryExpression));

                    if (isWrite) {
                      const wId = makeId('pci:occ:', ctx.id, source.path, source.hash, start, end, 'writes', target.id);
                      relationships.push({
                        id: wId,
                        contextId: ctx.id,
                        filePath: source.path,
                        hash: source.hash,
                        ownerId,
                        targetId: target.id,
                        start,
                        end,
                        range,
                        resolution: 'resolved',
                        kind: 'writes'
                      });
                    }
                    if (!isWrite || isCompound) {
                      const rId = makeId('pci:occ:', ctx.id, source.path, source.hash, start, end, 'reads', target.id);
                      relationships.push({
                        id: rId,
                        contextId: ctx.id,
                        filePath: source.path,
                        hash: source.hash,
                        ownerId,
                        targetId: target.id,
                        start,
                        end,
                        range,
                        resolution: 'resolved',
                        kind: 'reads'
                      });
                    }
                    recordCrossProjectDependency(target, start, end, range);
                  }
                } catch {
                  // Ignore
                }
              }
            }

            node.forEachChild(walk);
          }

          sf.forEachChild(walk);
        }
      }

      // Now back-fill any may_call edges where a call occurred before the implementing class was visited
      for (const call of [...calls]) {
        if (call.kind !== 'calls' || !call.targetId) continue;
        const impls = implementingMethods.get(call.targetId);
        if (!impls) continue;
        for (const implId of impls) {
          if (implId === call.targetId) continue;
          const mayId = makeId('pci:call:', call.contextId, call.filePath, call.hash, call.start, call.end, 'may_call', implId);
          if (!calls.some(c => c.id === mayId)) {
            calls.push({
              id: mayId,
              contextId: call.contextId,
              filePath: call.filePath,
              hash: call.hash,
              ownerId: call.ownerId,
              targetId: implId,
              start: call.start,
              end: call.end,
              range: call.range,
              resolution: 'possible',
              kind: 'may_call'
            });
          }
        }
      }

      return {
        protocolVersion: PROTOCOL_VERSION,
        adapterVersion: ADAPTER_VERSION,
        contexts: contextList.map(c => ({
          key: c.key,
          projectPath: c.projectPath,
          id: c.id,
          hash: c.hash,
          resolution: c.resolution,
          language: c.language,
          adapterVersion: c.adapterVersion,
          sourcePaths: c.sources.map(s => s.path)
        })),
        symbols: [...symbols.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        calls,
        relationships,
        configuredDependencies: [...configuredDependencies.values()].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0
        ),
        diagnostics
      };
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

async function main() {
  const ts = await loadTypeScript();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const request = JSON.parse(line);
      if (request.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`Unsupported sidecar protocol version: ${request.protocolVersion}`);
      }
      const result = analyzeRepository(ts, request);
      writeStdout(JSON.stringify(result) + '\n');
    } catch (error) {
      writeStdout(
        JSON.stringify({
          protocolVersion: PROTOCOL_VERSION,
          error: {
            code: error.message?.startsWith('IDENTITY_COLLISION') ? 'IDENTITY_COLLISION' : 'SIDECAR_FAILED',
            message: error.message || String(error)
          }
        }) + '\n'
      );
    }
  }
}

main().catch(error => {
  writeStdout(
    JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      error: { code: 'SIDECAR_STARTUP_FAILED', message: error.message || String(error) }
    }) + '\n'
  );
  process.exitCode = 1;
});
