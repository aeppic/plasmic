import * as parser from "@babel/parser";
import traverse, { Node, NodePath } from "@babel/traverse";
import {
  JSXElement,
  JSXAttribute,
  JSXSpreadAttribute,
  Comment,
  Expression,
  JSXEmptyExpression,
  StringLiteral,
  JSXText,
  TSNonNullExpression,
  MemberExpression,
  JSXSpreadChild,
  JSXFragment,
  JSXExpressionContainer,
  V8IntrinsicIdentifier,
  AssignmentExpression,
  ReturnStatement,
  ImportDeclaration
} from "@babel/types";
import * as babel from "@babel/core";
import * as L from "lodash";
import generate from "@babel/generator";
import { cloneDeepWithHook } from "./cloneDeepWithHook";
import { assert, withoutNils, ensure, assertEq } from "./common";
import {
  PlasmicASTNode,
  PlasmicJsxElement,
  PlasmicTagOrComponent,
  makeCallExpression,
  wrapInJsxExprContainer,
  PlasmicArgRef
} from "./plasmic-ast";
import {
  CodeVersion,
  helperObject,
  isInHtmlContext,
  calleeMatch,
  memberExpressionMatch,
  makeMemberExpression
} from "./plasmic-parser";
import { nodesDeepEqualIgnoreComments, code, formatted } from "./utils";
import { first, cloneDeep } from "lodash";

const getNamedAttrs = (jsxElement: JSXElement) => {
  const attrs = new Map<string, JSXAttribute>();
  for (const attr of jsxElement.openingElement.attributes) {
    if (attr.type !== "JSXAttribute") {
      continue;
    }
    assert(L.isString(attr.name.name));
    attrs.set(attr.name.name, attr);
  }
  return attrs;
};

const findAttrValueNode = (name: string, jsxElement: PlasmicJsxElement) => {
  for (const attr of jsxElement.attrs) {
    if (L.isString(attr)) {
      continue;
    }
    if (attr[0] === name) {
      return attr[1];
    }
  }
  return undefined;
};

const mergeAttributes = (
  newNode: PlasmicTagOrComponent,
  editedNode: PlasmicTagOrComponent,
  baseNode: PlasmicTagOrComponent,
  newVersion: CodeVersion,
  editedVersion: CodeVersion,
  baseVersion: CodeVersion
) => {
  const editedNodeId = editedNode.jsxElement.nameInId;
  const newNodeId = newNode.jsxElement.nameInId;

  const newNodeHasClassNameAttr = newVersion.hasClassNameIdAttr(newNode);
  const newNodeHasPropsWithIdSpreador = newVersion.hasPropsIdSpreador(newNode);
  // Only one of newNodeHasClassNameAttr and newNodeHasPropsWithIdSpreador is
  // true
  assert(newNodeHasPropsWithIdSpreador !== newNodeHasClassNameAttr);
  const newNamedAttrs = getNamedAttrs(newNode.jsxElement.rawNode);
  const editedNamedAttrs = getNamedAttrs(editedNode.jsxElement.rawNode);
  const baseNamedAttrs = getNamedAttrs(baseNode.jsxElement.rawNode);

  const conflictResolution = (
    name: string,
    baseAttr: JSXAttribute | undefined,
    editedAttr: JSXAttribute,
    newAttr: JSXAttribute
  ) => {
    // If attribute match, then emit either version is ok. Emitting it at the
    // place where the edited version emitted at is probably safer, and less
    // disturbing.
    if (nodesDeepEqualIgnoreComments(editedAttr, newAttr)) {
      return "emit-edited";
    }
    if (!baseAttr) {
      // We don't know how to handle the conflict. Emit both and let developer
      // handle it.
      return "emit-both";
    }
    if (nodesDeepEqualIgnoreComments(baseAttr, editedAttr)) {
      // User didn't edit it. Emit the new version.
      return "emit-new";
    }
    if (
      name.startsWith("on") ||
      nodesDeepEqualIgnoreComments(baseAttr, newAttr)
    ) {
      // Plasmic doesn't change it. Emit the edited version then.
      // Note that we specialize "onXXX" to account of id change.
      return "emit-edited";
    }
    // Both Plasmic and developer edited it. Emit both.
    // TODO: for event handler, maybe emit edited version, but replace the
    // identifier?
    return "emit-both";
  };

  // Return new attributes in newNode to be inserted.
  const newAttrsBeforeIdNode = () => {
    const newAttrs: Array<JSXAttribute> = [];
    newNamedAttrs.forEach((attr, name) => {
      if (name === "className") {
        // skip the id attribute
        return;
      }
      const editedAttr = editedNamedAttrs.get(name);
      const baseAttr = baseNamedAttrs.get(name);
      if (editedAttr) {
        const res = conflictResolution(name, baseAttr, editedAttr, attr);
        if (res === "emit-both" || res === "emit-new") {
          newAttrs.push(attr);
        }
      } else if (!baseAttr) {
        // newly added attribute in new version
        const attrValueNode = ensure(
          findAttrValueNode(name, newNode.jsxElement)
        );
        assert(attrValueNode.rawNode.type === "JSXExpressionContainer");
        const mergedNewValue = ensure(
          serializePlasmicASTNode(
            attrValueNode,
            newVersion,
            editedVersion,
            baseVersion
          )
        );
        assert(mergedNewValue.type === "JSXExpressionContainer");
        newAttrs.push(babel.types.jsxAttribute(attr.name, mergedNewValue));
      } else {
        // developer deleted the attribute. Keep it deleted - this is likely
        // due to developer doing some refactoring of the component.
        // TODO: only keep it deleted if there is no change to to the attribute
      }
    });
    return newAttrs;
  };

  const emitAttrInEditedNode = (name: string, editedAttr: JSXAttribute) => {
    const newAttr = newNamedAttrs.get(name);
    const baseAttr = baseNamedAttrs.get(name);
    if (newAttr) {
      const res = conflictResolution(name, baseAttr, editedAttr, newAttr);
      if (!(res === "emit-both" || res === "emit-edited")) {
        return undefined;
      }
      // Upgrade id in edited version for event handler
      if (name.startsWith("on") && editedNodeId !== newNodeId) {
        const eventNameInId = name.substring(2);
        return cloneDeepWithHook(editedAttr, (n: Node) => {
          if (
            memberExpressionMatch(
              n,
              helperObject,
              `on${editedNodeId}${eventNameInId}`
            )
          ) {
            return makeMemberExpression(
              helperObject,
              `on${newNodeId}${eventNameInId}`
            );
          }
          return undefined;
        });
      }
      return editedAttr;
    } else if (!baseAttr) {
      // user added attribute in edited version. Emit the edited attribute
      // without any transformation.
      return editedAttr;
    } else {
      // Attribute deleted in new version. However, user may have modified it.
      // For now, just delete it.
      // TODO: if user has modified it, leave it but add some comment; if user
      // has not modified it, delete it.
      return undefined;
    }
  };

  const mergedAttrs: Array<
    JSXAttribute | JSXSpreadAttribute
  > = newAttrsBeforeIdNode();

  for (const attrInEditedNode of editedNode.jsxElement.rawNode.openingElement
    .attributes) {
    if (attrInEditedNode.type === "JSXSpreadAttribute") {
      const arg = attrInEditedNode.argument;
      if (
        arg.type === "CallExpression" &&
        calleeMatch(arg.callee, helperObject, `props${editedNodeId}`)
      ) {
        assert(arg.callee.type === "MemberExpression");
        if (newNodeHasPropsWithIdSpreador) {
          // Keep the id as props but using new node id.
          mergedAttrs.push(
            cloneDeepWithHook(attrInEditedNode, n => {
              if (n === arg.callee) {
                const cloned = babel.types.clone(arg.callee);
                (cloned as MemberExpression).property.name = `props${newNodeId}`;
                return cloned;
              }
              return undefined;
            })
          );
        } else {
          const newAttr = babel.types.jsxAttribute(
            babel.types.jsxIdentifier("className"),
            babel.types.jsxExpressionContainer(
              makeCallExpression(helperObject, `cls${newNodeId}`)
            )
          );
          if (arg.arguments.length === 0) {
            // Downgrade to "className={rh.clsXXX()}".
            mergedAttrs.push(newAttr);
          } else {
            // insert "className={rh.clsXXX()}" - the old "rh.propsXXX" call
            // should lead to compilation failrue for developer to fix.
            mergedAttrs.push(newAttr, attrInEditedNode);
          }
        }
      } else {
        mergedAttrs.push(attrInEditedNode);
      }
      continue;
    }
    const attrName =
      attrInEditedNode.name.type === "JSXIdentifier"
        ? attrInEditedNode.name.name
        : attrInEditedNode.name.name.name;
    if (
      attrName === "className" &&
      attrInEditedNode.value?.type === "JSXExpressionContainer"
    ) {
      const expr = attrInEditedNode.value.expression;
      if (
        expr.type === "CallExpression" &&
        calleeMatch(expr.callee, helperObject, `cls${editedNodeId}`)
      ) {
        assert(expr.callee.type === "MemberExpression");
        if (newNodeHasPropsWithIdSpreador) {
          // Upgrade to {...propsXXX()}.
          const newAttr = babel.types.jsxSpreadAttribute(
            makeCallExpression(helperObject, `props${newNodeId}`)
          );
          mergedAttrs.push(newAttr);
        } else {
          // Keep it as className, but using the new id.
          const newAttr = babel.types.jsxAttribute(
            babel.types.jsxIdentifier("className"),
            babel.types.jsxExpressionContainer(
              makeCallExpression(helperObject, `cls${newNodeId}`)
            )
          );
          mergedAttrs.push(newAttr);
        }
        continue;
      }
    }
    const toEmit = emitAttrInEditedNode(attrName, attrInEditedNode);
    if (toEmit) {
      mergedAttrs.push(toEmit);
    }
  }
  return mergedAttrs;
};

type JsxChildType =
  | JSXText
  | JSXExpressionContainer
  | JSXSpreadChild
  | JSXElement
  | JSXFragment;

interface PerfectMatch {
  type: "perfect";
  index: number;
}

interface TypeMatch {
  type: "type";
  index: number;
}

interface NoMatch {
  type: "none";
}

type MatchResult = PerfectMatch | TypeMatch | NoMatch;

const findMatch = (
  nodes: PlasmicASTNode[],
  start: number,
  idMatchChecker: (idInNodes: string, idInN: string) => boolean,
  n: PlasmicASTNode
): MatchResult => {
  let matchingTypeAt = -1;
  if (n.type === "text" || n.type === "string-lit") {
    for (let i = start; i < nodes.length; i++) {
      const ni = nodes[i];
      if (ni.type === "text" || ni.type === "string-lit") {
        if (ni.value === n.value) {
          return { type: "perfect", index: i };
        }
        if (matchingTypeAt === -1) {
          matchingTypeAt = i;
        }
      }
    }
  } else if (n.type === "arg") {
    for (let i = start; i < nodes.length; i++) {
      const ni = nodes[i];
      if (ni.type === "arg") {
        if (n.argName === ni.argName) {
          return { type: "perfect", index: i };
        }
        if (matchingTypeAt === -1) {
          matchingTypeAt = i;
        }
      }
    }
  } else if (n.type === "cond-str-call") {
    for (let i = start; i < nodes.length; i++) {
      const ni = nodes[i];
      if (ni.type === "cond-str-call") {
        return { type: "perfect", index: i };
      }
      if (matchingTypeAt === -1) {
        matchingTypeAt = i;
      }
    }
  } else if (n.type === "tag-or-component") {
    for (let i = start; i < nodes.length; i++) {
      const ni = nodes[i];
      if (
        ni.type === "tag-or-component" &&
        idMatchChecker(ni.jsxElement.nameInId, n.jsxElement.nameInId)
      ) {
        return { type: "perfect", index: i };
      }
      if (matchingTypeAt === -1) {
        matchingTypeAt = i;
      }
    }
  }
  return matchingTypeAt !== -1
    ? { type: "type", index: matchingTypeAt }
    : { type: "none" };
};

const mergedChildren = (
  newNode: PlasmicTagOrComponent,
  editedNode: PlasmicTagOrComponent,
  baseNode: PlasmicTagOrComponent,
  newVersion: CodeVersion,
  editedVersion: CodeVersion,
  baseVersion: CodeVersion
): Array<JsxChildType> => {
  let nextInsertStartAt = 0;
  const insertEditedNodeIntoNew = (
    editedChild: PlasmicASTNode,
    prevEditedChild: PlasmicASTNode | undefined
  ) => {
    if (!prevEditedChild) {
      merged.splice(0, 0, editedChild);
      nextInsertStartAt = 1;
    } else {
      const prevMatch = findMatch(
        merged,
        nextInsertStartAt,
        (newNameInId, editedNameInId) =>
          newNameInId === editedNameInId ||
          editedVersion.getUuid(editedNameInId) ===
            newVersion.getUuid(newNameInId),
        prevEditedChild
      );
      if (prevMatch.type === "perfect" || prevMatch.type === "type") {
        // previous node matches merged[prevMatch]. insert current node at
        // prevMatch + 1.
        merged.splice(prevMatch.index + 1, 0, editedChild);
        nextInsertStartAt = prevMatch.index + 2;
      } else {
        merged.splice(nextInsertStartAt, 0, editedChild);
        nextInsertStartAt += 1;
      }
    }
  };

  const newChildren = newNode.jsxElement.children;
  const merged = newNode.jsxElement.children.slice(0);

  const editedChildren = editedNode.jsxElement.children;
  editedChildren.forEach((editedChild, i) => {
    if (editedChild.type === "text" || editedChild.type === "string-lit") {
      const matchInNewVersion = findMatch(
        merged,
        nextInsertStartAt,
        (newNameInId, editedNameInId) =>
          newNameInId === editedNameInId ||
          editedVersion.getUuid(editedNameInId) ===
            newVersion.getUuid(newNameInId),
        editedChild
      );
      if (matchInNewVersion.type === "perfect") {
        // skip text node if it matches some text in new version. But make sure
        // subsequent nodes are inserted after the match.
        nextInsertStartAt = matchInNewVersion.index + 1;
        return;
      }
      const matchInBaseVersion = findMatch(
        baseNode.jsxElement.children,
        0,
        (baseNameInId, editedNameInId) =>
          baseNameInId === editedNameInId ||
          editedVersion.getUuid(editedNameInId) ===
            baseVersion.getUuid(baseNameInId),
        editedChild
      );
      if (matchInBaseVersion.type === "perfect") {
        // skip text node if it matches some text in base version
        return;
      }
      insertEditedNodeIntoNew(editedChild, editedChildren[i - 1]);
    } else if (editedChild.type === "opaque") {
      insertEditedNodeIntoNew(editedChild, editedChildren[i - 1]);
    }
  });

  return withoutNils(
    merged.map(c => {
      if (!newChildren.includes(c)) {
        // children preserved from editedNode doesn't need any fixing.
        return c.rawNode as JsxChildType;
      }
      if (c.type === "opaque") {
        return c.rawNode as JsxChildType;
      }
      const n = serializeNonOpaquePlasmicASTNode(
        c,
        newVersion,
        editedVersion,
        baseVersion
      );
      if (!n) {
        return undefined;
      }
      if (babel.types.isExpression(n)) {
        // need to wrap in expression container
        return n.type !== "JSXElement" && n.type !== "JSXFragment"
          ? babel.types.jsxExpressionContainer(n)
          : n;
      }
      return n;
    })
  );
};

const makeJsxElementWithShowCall = (jsxElement: JSXElement, nodeId: string) =>
  babel.types.logicalExpression(
    "&&",
    makeCallExpression(helperObject, `show${nodeId}`),
    jsxElement
  );

const mergeShowFunc = (
  newNode: PlasmicTagOrComponent,
  editedNode: PlasmicTagOrComponent,
  newVersion: CodeVersion,
  editedVersion: CodeVersion,
  editedNodeClone: Expression | JSXExpressionContainer
) => {
  const editedNodeId = editedNode.jsxElement.nameInId;
  const newNodeId = newNode.jsxElement.nameInId;
  const newNodeCallShowFunc = newVersion.hasShowFuncCall(newNode);
  let replacedShowCall = false;
  traverse(editedNodeClone, {
    noScope: true,
    CallExpression: function(path) {
      const call = path.node;
      if (calleeMatch(call.callee, helperObject, `show${editedNodeId}`)) {
        if (newNodeCallShowFunc) {
          assert(call.callee.type === "MemberExpression");
          call.callee.property = babel.types.identifier(`show${newNodeId}`);
        } else {
          path.replaceWithSourceString("true");
        }
        replacedShowCall = true;
        path.skip();
      }
    }
  });
  if (newNodeCallShowFunc && !replacedShowCall) {
    // add the show call, using the new node id!
    if (editedNode.rawNode === editedNode.jsxElement.rawNode) {
      assert(editedNodeClone.type === "JSXElement");
      return makeJsxElementWithShowCall(editedNodeClone, newNodeId);
    } else {
      traverse(editedNodeClone, {
        noScope: true,
        JSXElement: function(path) {
          // We have to use location to identify the node since they point to
          // different AST structure - one point to the editedNode.rawNode, and
          // the other point to editedNodeClone.
          if (path.node.start === editedNode.jsxElement.rawNode.start) {
            const inHtmlContext = isInHtmlContext(path);
            const expr = makeJsxElementWithShowCall(path.node, newNodeId);
            // we are converting JSXElement to an expression. So maybe we need
            // a JSXExpressionContainer.
            path.replaceWith(
              inHtmlContext ? wrapInJsxExprContainer(expr) : expr
            );
            path.stop();
          }
        }
      });
    }
  }
  return editedNodeClone;
};

const serializeTagOrComponent = (
  newNode: PlasmicTagOrComponent,
  newVersion: CodeVersion,
  editedVersion: CodeVersion,
  baseVersion: CodeVersion
): Expression | JSXExpressionContainer | undefined => {
  const nodeId = newVersion.getId(newNode);
  // find node with same id in edited version.
  const editedNode = editedVersion.findNode(nodeId);
  const baseNode = baseVersion.findNode(nodeId);
  if (editedNode) {
    // the node must exist in base versio.
    assert(!!baseNode);
    const editedNodeJsxElementClone = babel.types.cloneDeep(
      editedNode.jsxElement.rawNode
    );

    editedNodeJsxElementClone.openingElement.attributes = mergeAttributes(
      newNode,
      editedNode,
      baseNode,
      newVersion,
      editedVersion,
      baseVersion
    );

    editedNodeJsxElementClone.children = mergedChildren(
      newNode,
      editedNode,
      baseNode,
      newVersion,
      editedVersion,
      baseVersion
    );
    if (
      !editedNodeJsxElementClone.closingElement &&
      editedNodeJsxElementClone.children.length > 0
    ) {
      editedNodeJsxElementClone.closingElement = babel.types.jsxClosingElement(
        editedNodeJsxElementClone.openingElement.name
      );
    }

    const editNodeClone = cloneDeepWithHook(editedNode.rawNode, (n: Node) => {
      if (n === editedNode.jsxElement.rawNode) {
        return editedNodeJsxElementClone;
      }
      return undefined;
    });

    return mergeShowFunc(
      newNode,
      editedNode,
      newVersion,
      editedVersion,
      editNodeClone
    );
  }
  // check if the node has been deleted.
  if (baseNode) {
    // If so, don't output anything
    return undefined;
  }
  // This is new node. Just output self.
  return newNode.rawNode;
};

const serializeNonOpaquePlasmicASTNode = (
  newNode: PlasmicASTNode,
  newVersion: CodeVersion,
  editedVersion: CodeVersion,
  baseVersion: CodeVersion
): Expression | JSXExpressionContainer | JSXText | undefined => {
  assert(newNode.type !== "opaque");
  if (newNode.type === "arg") {
    const nodesToMerged = new Map<Node, Node>();
    newNode.jsxNodes.forEach(n => {
      const rawMerged = serializeTagOrComponent(
        n,
        newVersion,
        editedVersion,
        baseVersion
      );
      nodesToMerged.set(
        n.rawNode,
        rawMerged ||
          (n.rawNode.type === "JSXExpressionContainer"
            ? babel.types.jsxExpressionContainer(babel.types.nullLiteral())
            : babel.types.nullLiteral())
      );
    });
    return cloneDeepWithHook(newNode.rawNode, (n: Node) =>
      nodesToMerged.get(n)
    );
  } else if (newNode.type === "cond-str-call") {
    // Just output the new version
    return newNode.rawNode;
  } else if (newNode.type === "string-lit") {
    // Just output the new version
    return newNode.rawNode;
  } else if (newNode.type === "text") {
    // Just output the new version
    return newNode.rawNode;
  } else {
    assert(newNode.type === "tag-or-component");
    return serializeTagOrComponent(
      newNode,
      newVersion,
      editedVersion,
      baseVersion
    );
  }
};

export const serializePlasmicASTNode = (
  newNode: PlasmicASTNode,
  newVersion: CodeVersion,
  editedVersion: CodeVersion,
  baseVersion: CodeVersion
): Node | undefined => {
  if (newNode.type === "opaque") {
    return newNode.rawNode;
  }
  return serializeNonOpaquePlasmicASTNode(
    newNode,
    newVersion,
    editedVersion,
    baseVersion
  );
};

export class ComponentSkeletonModel {
  constructor(
    readonly uuid: string,
    readonly nameInIdToUuid: Map<string, string>,
    readonly fileContent: string
  ) {}

  toJSON() {
    return {
      uuid: this.uuid,
      nameInIdToUuid: [...this.nameInIdToUuid.entries()],
      fileContent: this.fileContent
    };
  }

  static fromJsObject(jsObj: any) {
    return new ComponentSkeletonModel(
      jsObj.uuid,
      new Map<string, string>(jsObj.nameInIdToUuid as Array<[string, string]>),
      jsObj.fileContent
    );
  }
}

export class ProjectSyncMetadataModel {
  constructor(readonly components: ComponentSkeletonModel[]) {}

  toJSON() {
    return this.components;
  }

  static fromJson(json: string) {
    const j = JSON.parse(json);
    assert(L.isArray(j));
    return new ProjectSyncMetadataModel(
      j.map(item => ComponentSkeletonModel.fromJsObject(item))
    );
  }
}

export const makeCachedProjectSyncDataProvider = (
  rawProvider: ProjectSyncDataProviderType
): ProjectSyncDataProviderType => {
  type Entry = {
    proejctId: string;
    revision: number;
    model: ProjectSyncMetadataModel;
  };
  const cache: Array<Entry> = [];
  return (projectId: string, revision: number) => {
    const cached = cache.find(
      ent => ent.proejctId === projectId && ent.revision === revision
    );
    if (cached) {
      return Promise.resolve(cached.model);
    }
    return rawProvider(projectId, revision);
  };
};

export type ProjectSyncDataProviderType = (
  projectId: string,
  revision: number
) => Promise<ProjectSyncMetadataModel>;

interface PlasmicComponentSkeletonFile {
  jsx: Expression;
  file: babel.types.File;
  revision: number;
  identifyingComment: Comment;
}

interface VersionedJsx {
  jsx: Expression;
  revision: number;
  identifyingComment: Comment;
}

const tryExtractPlasmicJsxExpression = (
  node: AssignmentExpression | ReturnStatement
): VersionedJsx | undefined => {
  for (const c of node.leadingComments || []) {
    const m = c.value.match(/^\s*plasmic-managed-jsx\/(\d+)\s*$/);
    if (m) {
      if (node.type === "AssignmentExpression") {
        return { jsx: node.right, identifyingComment: c, revision: +m[1] };
      } else {
        return {
          jsx: ensure(node.argument),
          identifyingComment: c,
          revision: +m[1]
        };
      }
    }
  }
  return undefined;
};

const tryParseComponentSkeletonFile = (
  fileContent: string
): PlasmicComponentSkeletonFile | undefined => {
  const file = parser.parse(fileContent, {
    strictMode: true,
    sourceType: "module",
    plugins: ["jsx", "typescript"]
  });
  let jsx: VersionedJsx | undefined = undefined;
  traverse(file, {
    noScope: true,
    AssignmentExpression: function(path) {
      jsx = tryExtractPlasmicJsxExpression(path.node);
      if (jsx) {
        path.stop();
      }
    },
    ReturnStatement: function(path) {
      jsx = tryExtractPlasmicJsxExpression(path.node);
      if (jsx) {
        path.stop();
      }
    }
  });
  // typescript treat jsx as never type... why?
  jsx = jsx as VersionedJsx | undefined;
  return jsx ? { ...jsx, file } : undefined;
};

type PlasmicImportType =
  | "renderer"
  | "css"
  | "component"
  | "globalVariant"
  | "projectCss"
  | "defaultcss"
  | undefined;

const tryParsePlasmicImportSpec = (node: ImportDeclaration) => {
  const c = node.trailingComments?.[0];
  if (!c) {
    return undefined;
  }
  const m = c.value.match(
    /plasmic-import:\s+([\w-]+)(?:\/(component|css|render|globalVariant|projectcss|defaultcss))?/
  );
  if (m) {
    return { id: m[1], type: m[2] as PlasmicImportType };
  }
  return undefined;
};

const compareImports = (
  import1: PlasmicImportSpec,
  import2: PlasmicImportSpec
) => {
  if (import1.id !== import2.id) {
    return import1.id < import2.id ? -1 : 1;
  }
  if (import1.type !== import2.type) {
    if (import1.type === undefined) {
      return -1;
    }
    if (import2.type === undefined) {
      return 1;
    }
    return import1.type < import2.type ? -1 : 1;
  }
  return 0;
};

// merge slave into master
const mergeImports = (i1: ImportDeclaration, i2: ImportDeclaration) => {
  const cloned = cloneDeep(i1);
  for (const s2 of i2.specifiers) {
    if (s2.type === "ImportDefaultSpecifier") {
      if (
        i1.specifiers.find(
          s1 =>
            s1.type === "ImportDefaultSpecifier" &&
            s1.local.name === s2.local.name
        )
      ) {
        continue;
      }
      cloned.specifiers.push(s2);
    } else if (s2.type === "ImportSpecifier") {
      if (
        i1.specifiers.find(
          s1 =>
            s1.type === "ImportSpecifier" &&
            s1.local.name === s2.local.name &&
            s1.imported.name === s2.imported.name
        )
      ) {
        continue;
      }
      cloned.specifiers.push(s2);
    } else {
      assert(s2.type === "ImportNamespaceSpecifier");
      // Plasmic doesn't generate namespace import statement.
      cloned.specifiers.push(s2);
    }
  }
  return cloned;
};

const mergePlasmicImports = (
  mergedFile: babel.types.File,
  parsedNew: PlasmicComponentSkeletonFile,
  parsedEdited: PlasmicComponentSkeletonFile
) => {
  const newImports = extractPlasmicImports(parsedNew.file);
  const editedImports = extractPlasmicImports(parsedEdited.file);

  let firstImport = -1;
  let firstPlasmicImport = -1;
  // Remove all imports that is being merged.
  mergedFile.program.body = mergedFile.program.body.filter((stmt, i) => {
    if (stmt.type === "ImportDeclaration") {
      if (firstImport === -1) {
        firstImport = i;
      }
      if (tryParsePlasmicImportSpec(stmt)) {
        if (firstPlasmicImport === -1) {
          firstPlasmicImport = i;
        }
        return false;
      }
    }
    return true;
  });
  // TODO: perform the merge!
  const mergedImports: Array<ImportDeclaration> = [];
  // edited imports are ordered first
  const allImports = [...editedImports, ...newImports];
  allImports.sort(compareImports);
  // Remove leadingComments - babel parser assign each comment to two nodes.
  // One as a trailing comment of the node before the comment, and one as a
  // leading comment of the node after the comment. We remove the
  // leadingComments so that we don't generate the comments twice (one from
  // editedImports, and one from newImports).
  allImports.forEach(importDecl => (importDecl.node.leadingComments = null));
  let i = 0;
  while (i < allImports.length) {
    if (
      i + 1 < allImports.length &&
      compareImports(allImports[i], allImports[i + 1]) === 0
    ) {
      mergedImports.push(
        mergeImports(allImports[i].node, allImports[i + 1].node)
      );
      i++;
    } else {
      mergedImports.push(allImports[i].node);
    }
    i++;
  }
  const insertMergedImportsAt =
    firstPlasmicImport > -1
      ? firstPlasmicImport
      : firstImport > -1
      ? firstImport
      : 0;
  mergedFile.program.body.splice(insertMergedImportsAt, 0, ...mergedImports);
};

interface PlasmicImportSpec {
  id: string;
  type: PlasmicImportType;
  node: ImportDeclaration;
}

const extractPlasmicImports = (file: babel.types.File) => {
  const plasmicImports: Array<PlasmicImportSpec> = [];
  traverse(file, {
    ImportDeclaration: function(path) {
      const importSpec = tryParsePlasmicImportSpec(path.node);
      if (importSpec) {
        plasmicImports.push({ ...importSpec, node: path.node });
      }
      path.skip();
    }
  });
  return plasmicImports;
};

export type ComponentInfoForMerge = {
  // edited version of the code, i.e. the entire file.
  editedFile: string;
  newFile: string;
  // map for newCode
  newNameInIdToUuid: Map<string, string>;
};

export const mergeFiles = async (
  componentByUuid: Map<string, ComponentInfoForMerge>,
  projectId: string,
  projectSyncDataProvider: ProjectSyncDataProviderType
) => {
  const updateableByComponentUuid = new Map<
    string,
    PlasmicComponentSkeletonFile
  >();
  componentByUuid.forEach((codeVersions, uuid) => {
    const parsedEdited = tryParseComponentSkeletonFile(codeVersions.editedFile);
    if (parsedEdited) {
      updateableByComponentUuid.set(uuid, parsedEdited);
    }
  });
  if (updateableByComponentUuid.size === 0) {
    // Nothing to update
    return;
  }

  const mergedFiles = new Map<string, string>();

  for (const [componentUuid, parsedEdited] of updateableByComponentUuid) {
    const projectSyncData = await projectSyncDataProvider(
      projectId,
      parsedEdited.revision
    );
    const baseMetadata = ensure(
      projectSyncData.components.find(c => c.uuid === componentUuid)
    );
    const parsedBase = ensure(
      tryParseComponentSkeletonFile(baseMetadata.fileContent)
    );
    const baseCodeVersion = new CodeVersion(
      baseMetadata.fileContent,
      baseMetadata.nameInIdToUuid,
      parsedBase.jsx
    );

    // All other metadata
    const component = ensure(componentByUuid.get(componentUuid));
    const editedCodeVersion = new CodeVersion(
      component.editedFile,
      // edited version share the same nameInIdtoUuid mapping
      baseMetadata.nameInIdToUuid,
      parsedEdited.jsx
    );
    const parsedNew = ensure(tryParseComponentSkeletonFile(component.newFile));
    const newCodeVersion = new CodeVersion(
      component.newFile,
      component.newNameInIdToUuid,
      parsedNew.jsx
    );
    const newJsx = serializePlasmicASTNode(
      newCodeVersion.root,
      newCodeVersion,
      editedCodeVersion,
      baseCodeVersion
    );

    // Ideally, we should keep parsedEdited read-only, but, it is not a big deal
    // to modify the comment.
    parsedEdited.identifyingComment.value = ` plasmic-managed-jsx/${parsedNew.revision}`;
    const mergedFile = cloneDeepWithHook(parsedEdited.file, (n: Node) => {
      if (n === parsedEdited.jsx) {
        return newJsx;
      }
      return undefined;
    });
    mergePlasmicImports(mergedFile, parsedNew, parsedEdited);
    const mergedCode = code(mergedFile, { retainLines: true });
    // Replace the plasmic-managed code block
    const plasmicManagedRegex = /\/\/\s*plasmic-managed-start[\s\S]*\/\/\s*plasmic-managed-end/;
    const newFragment = component.newFile.match(plasmicManagedRegex);
    assert(newFragment);
    const replacedCode = mergedCode.replace(
      plasmicManagedRegex,
      newFragment[0]
    );
    mergedFiles.set(componentUuid, formatted(replacedCode));
  }
  return mergedFiles;
};