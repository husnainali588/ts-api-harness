// Shared static analysis for the standards rules: route discovery (template `defineRoute` and hand-written
// Express routers), schema key resolution and small AST helpers. Folders starting with "_" are not plugins.
import { Node, SyntaxKind, type CallExpression, type ObjectLiteralExpression, type Project, type SourceFile } from 'ts-morph';

export const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
export type Method = (typeof METHODS)[number];
const isMethod = (s: string): s is Method => (METHODS as readonly string[]).includes(s);

export interface RouteSite {
  file: string; // API-root-relative
  line: number;
  col: number;
  method: Method;
  path: string; // full path, e.g. /v1/users/:id
  style: 'define' | 'express';
  call: CallExpression;
  spec?: ObjectLiteralExpression; // define style
  handlers: Node[]; // function-like nodes
}

export function rel(apiRoot: string, sf: SourceFile): string {
  const p = sf.getFilePath();
  return (p.startsWith(apiRoot) ? p.slice(apiRoot.length + 1) : p).split('\\').join('/');
}

export const isTestPath = (p: string) => /\.(test|spec)\.ts$/.test(p);
export const isSrcPath = (p: string) => p.startsWith('src/') && p.endsWith('.ts') && !isTestPath(p) && !p.endsWith('.d.ts');

export function loc(node: Node): { line: number; col: number } {
  const { line, column } = node.getSourceFile().getLineAndColumnAtPos(node.getStart());
  return { line, col: column };
}

export function stringValue(node: Node | undefined): string | undefined {
  if (node === undefined) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) return node.getLiteralValue();
  return undefined;
}

export function numberValue(node: Node | undefined): number | undefined {
  if (node !== undefined && Node.isNumericLiteral(node)) return node.getLiteralValue();
  return undefined;
}

/** Initializer of a property in an object literal (method declarations return themselves). */
export function getProp(obj: ObjectLiteralExpression, name: string): Node | undefined {
  const prop = obj.getProperty(name);
  if (prop === undefined) return undefined;
  if (Node.isPropertyAssignment(prop)) return prop.getInitializer();
  if (Node.isShorthandPropertyAssignment(prop)) return prop.getNameNode();
  if (Node.isMethodDeclaration(prop)) return prop;
  return undefined;
}

function declarationOf(id: Node): Node | undefined {
  let symbol = id.getSymbol();
  const aliased = symbol?.getAliasedSymbol();
  if (aliased !== undefined) symbol = aliased;
  return symbol?.getDeclarations()[0];
}

/** Follows identifiers (incl. imports), parentheses and `as`/`satisfies` to the value expression or declaration. */
export function resolveValue(node: Node | undefined, depth = 0): Node | undefined {
  if (node === undefined || depth > 8) return node;
  if (Node.isIdentifier(node)) {
    const decl = declarationOf(node);
    if (decl !== undefined && Node.isVariableDeclaration(decl)) return resolveValue(decl.getInitializer(), depth + 1);
    return decl;
  }
  if (Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isParenthesizedExpression(node)) {
    return resolveValue(node.getExpression(), depth + 1);
  }
  return node;
}

export function functionLike(node: Node | undefined): Node | undefined {
  const value = resolveValue(node);
  if (value === undefined) return undefined;
  if (Node.isArrowFunction(value) || Node.isFunctionExpression(value) || Node.isFunctionDeclaration(value) || Node.isMethodDeclaration(value)) return value;
  return undefined;
}

export function firstParamName(fn: Node): string | undefined {
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) {
    const p = fn.getParameters()[0];
    return p !== undefined && Node.isIdentifier(p.getNameNode()) ? p.getName() : undefined;
  }
  return undefined;
}

export function paramCount(fn: Node): number {
  if (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn)) return fn.getParameters().length;
  return -1;
}

const OBJECT_FACTORIES = new Set(['object', 'strictObject', 'looseObject']);
const KEY_PRESERVING = new Set(['refine', 'superRefine', 'check', 'optional', 'nullable', 'strict', 'strip', 'passthrough', 'describe', 'readonly', 'meta', 'default', 'catch', 'brand']);

/** Keys of a Zod object schema expression (follows identifiers, chains, .extend, and helper functions like pageOf). */
export function zodObjectKeys(node: Node | undefined, depth = 0): string[] | undefined {
  const value = resolveValue(node);
  if (value === undefined || depth > 6) return undefined;
  if (!Node.isCallExpression(value)) return undefined;
  const callee = value.getExpression();
  if (Node.isPropertyAccessExpression(callee)) {
    const name = callee.getName();
    if (OBJECT_FACTORIES.has(name) && callee.getExpression().getText() === 'z') {
      const arg = value.getArguments()[0];
      return arg !== undefined && Node.isObjectLiteralExpression(arg) ? arg.getProperties().flatMap((p) => (Node.isPropertyNamed(p) ? [p.getName()] : [])) : undefined;
    }
    if (name === 'extend') {
      const base = zodObjectKeys(callee.getExpression(), depth + 1) ?? [];
      const arg = value.getArguments()[0];
      const extra = arg !== undefined && Node.isObjectLiteralExpression(arg) ? arg.getProperties().flatMap((p) => (Node.isPropertyNamed(p) ? [p.getName()] : [])) : [];
      return [...base, ...extra];
    }
    if (KEY_PRESERVING.has(name)) return zodObjectKeys(callee.getExpression(), depth + 1);
    return undefined;
  }
  // A helper such as pageOf(Item): look at what the function returns.
  const fn = functionLike(callee);
  if (fn === undefined) return undefined;
  const returned = Node.isArrowFunction(fn) && !Node.isBlock(fn.getBody()) ? fn.getBody() : fn.getFirstDescendantByKind(SyntaxKind.ReturnStatement)?.getExpression();
  return zodObjectKeys(returned, depth + 1);
}

export function isParseCall(call: CallExpression): boolean {
  const callee = call.getExpression();
  if (Node.isPropertyAccessExpression(callee)) return /^(parse|safeParse|parseAsync|safeParseAsync)$/.test(callee.getName());
  return Node.isIdentifier(callee) && /^parse[A-Z]\w*$/.test(callee.getText());
}

/** True when the node sits inside the arguments of a schema parse call. */
export function insideParseArgs(node: Node): boolean {
  for (let cur: Node | undefined = node; cur !== undefined; cur = cur.getParent()) {
    const parent = cur.getParent();
    if (parent !== undefined && Node.isCallExpression(parent) && isParseCall(parent) && parent.getArguments().includes(cur)) return true;
    if (Node.isFunctionLikeDeclaration(cur) && cur !== node) return false;
  }
  return false;
}

/** The schema expression parsed by the parse call that receives `node` as an argument. */
export function schemaParsing(node: Node): Node | undefined {
  for (let cur: Node | undefined = node; cur !== undefined; cur = cur.getParent()) {
    const parent = cur.getParent();
    if (parent !== undefined && Node.isCallExpression(parent) && isParseCall(parent) && parent.getArguments().includes(cur)) {
      const callee = parent.getExpression();
      if (Node.isPropertyAccessExpression(callee)) return callee.getExpression();
      return parent.getArguments().find((a) => a !== cur);
    }
  }
  return undefined;
}

export function isExpressReceiver(node: Node): boolean {
  const text = node.getType().getText(node);
  return /\b(Router|Express|Application|IRouter)\b/.test(text);
}

function declFile(node: Node): string | undefined {
  const target = Node.isCallExpression(node) ? node.getExpression() : node;
  if (!Node.isIdentifier(target)) return undefined;
  const decl = declarationOf(target);
  if (decl === undefined) return undefined;
  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    if (init !== undefined && Node.isCallExpression(init)) return declFile(init);
  }
  return decl.getSourceFile().getFilePath();
}

const routeCache = new WeakMap<Project, RouteSite[]>();

/** Every route in the API's src/: defineRoute({...}) calls and router.METHOD('/path', ...) calls with mount prefixes. */
export function allRoutes(project: Project, apiRoot: string): RouteSite[] {
  const cached = routeCache.get(project);
  if (cached !== undefined) return cached;
  const files = project.getSourceFiles().filter((sf) => isSrcPath(rel(apiRoot, sf)));
  const prefixes = new Map<string, string>();
  for (const sf of files) {
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const [first, second] = call.getArguments();
      const prefix = stringValue(first);
      if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== 'use' || prefix === undefined || second === undefined) continue;
      const file = declFile(second);
      if (file !== undefined) prefixes.set(file, prefix.replace(/\/$/, ''));
    }
  }
  const routes: RouteSite[] = [];
  for (const sf of files) {
    const file = rel(apiRoot, sf);
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      const args = call.getArguments();
      if (Node.isIdentifier(callee) && callee.getText() === 'defineRoute') {
        const spec = args[0];
        if (spec === undefined || !Node.isObjectLiteralExpression(spec)) continue;
        const method = stringValue(getProp(spec, 'method'));
        const path = stringValue(getProp(spec, 'path'));
        if (method === undefined || path === undefined || !isMethod(method)) continue;
        const handler = functionLike(getProp(spec, 'handler'));
        routes.push({ file, ...loc(call), method, path, style: 'define', call, spec, handlers: handler === undefined ? [] : [handler] });
        continue;
      }
      if (Node.isPropertyAccessExpression(callee) && isMethod(callee.getName())) {
        const path = stringValue(args[0]);
        if (path === undefined || !path.startsWith('/') || args.length < 2 || !isExpressReceiver(callee.getExpression())) continue;
        const prefix = prefixes.get(sf.getFilePath()) ?? '';
        const full = path === '/' ? prefix || '/' : `${prefix}${path}`;
        const handlers = args.slice(1).flatMap((a) => {
          const fn = functionLike(a);
          return fn === undefined ? [] : [fn];
        });
        routes.push({ file, ...loc(call), method: callee.getName() as Method, path: full, style: 'express', call, handlers });
      }
    }
  }
  routeCache.set(project, routes);
  return routes;
}

export const pathParams = (path: string) => path.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1));
export const isItemPath = (path: string) => (path.split('/').at(-1) ?? '').startsWith(':');

/** All z.object-style schemas declared as variables in src/, with their keys (for duplicate-type detection). */
export function declaredSchemas(project: Project, apiRoot: string): { name: string; keys: string[]; file: string }[] {
  const out: { name: string; keys: string[]; file: string }[] = [];
  for (const sf of project.getSourceFiles().filter((s) => isSrcPath(rel(apiRoot, s)))) {
    for (const decl of sf.getVariableDeclarations()) {
      const keys = zodObjectKeys(decl.getInitializer());
      if (keys !== undefined) out.push({ name: decl.getName(), keys, file: rel(apiRoot, sf) });
    }
  }
  return out;
}

export function srcText(project: Project, apiRoot: string): string {
  return project
    .getSourceFiles()
    .filter((sf) => isSrcPath(rel(apiRoot, sf)))
    .map((sf) => sf.getFullText())
    .join('\n');
}
