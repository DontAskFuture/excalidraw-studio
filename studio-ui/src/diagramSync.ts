import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { parseMermaidToExcalidraw } from "@excalidraw/mermaid-to-excalidraw";
import {
  isCustomHexColor,
  isCustomStrokeColor,
  parsePlantUml,
  sanitizeIdentifier,
  serializeMermaid,
  type DiagramModel,
  type EdgeStyle,
  type FlowDirection,
  type FlowEdge,
  type FlowGraphModel,
  type FlowNode,
  type FlowShape,
  type FlowSubgraph,
  type SequenceMessage,
  type SequenceModel,
  type SequenceParticipant,
} from "@excalidraw/excalidraw/components/TTDDialog/plantuml";

export { parsePlantUml, sanitizeIdentifier, serializeMermaid };
export type {
  DiagramModel,
  EdgeStyle,
  FlowDirection,
  FlowEdge,
  FlowGraphModel,
  FlowNode,
  FlowShape,
  FlowSubgraph,
  SequenceMessage,
  SequenceModel,
  SequenceParticipant,
};

export type SyncFormat = "mermaid" | "plantuml";

interface DiagramSyncMeta {
  synced?: boolean;
  diagramKind?: "flowchart" | "sequence";
  nodeId?: string;
  participantId?: string;
  role?: "actor-top" | "actor-bottom" | "lifeline" | "message";
  shape?: FlowShape;
  label?: string;
  isSubgraph?: boolean;
  bgColor?: string;
  strokeColor?: string;
}

const GRAPH_ELEMENT_TYPES = new Set([
  "rectangle",
  "ellipse",
  "diamond",
  "arrow",
  "line",
  "text",
  "frame",
]);

function getSyncMeta(el: any): DiagramSyncMeta | undefined {
  return el?.customData?.diagramSync;
}

function looksLikeRandomExcalidrawId(id: string): boolean {
  if (!/^[A-Za-z0-9_-]{18,}$/.test(id)) {
    return false;
  }
  const hasUpper = /[A-Z]/.test(id);
  const hasLower = /[a-z]/.test(id);
  const hasDigitOrSymbol = /[0-9_-]/.test(id);
  return hasUpper && hasLower && hasDigitOrSymbol;
}

function elementArea(el: any): number {
  return Math.max(0, Number(el?.width) || 0) * Math.max(0, Number(el?.height) || 0);
}

function elementCenter(el: any): { x: number; y: number } {
  return {
    x: (Number(el?.x) || 0) + (Number(el?.width) || 0) / 2,
    y: (Number(el?.y) || 0) + (Number(el?.height) || 0) / 2,
  };
}

function rectContainsPoint(rect: any, pt: { x: number; y: number }, pad = 0): boolean {
  const x = (Number(rect?.x) || 0) - pad;
  const y = (Number(rect?.y) || 0) - pad;
  const w = (Number(rect?.width) || 0) + pad * 2;
  const h = (Number(rect?.height) || 0) + pad * 2;
  return pt.x >= x && pt.x <= x + w && pt.y >= y && pt.y <= y + h;
}

function distancePointToRect(rect: any, pt: { x: number; y: number }): number {
  const x1 = Number(rect?.x) || 0;
  const y1 = Number(rect?.y) || 0;
  const x2 = x1 + (Number(rect?.width) || 0);
  const y2 = y1 + (Number(rect?.height) || 0);
  const dx = pt.x < x1 ? x1 - pt.x : pt.x > x2 ? pt.x - x2 : 0;
  const dy = pt.y < y1 ? y1 - pt.y : pt.y > y2 ? pt.y - y2 : 0;
  return Math.hypot(dx, dy);
}

function buildTextLookups(active: any[]) {
  const boundTextByContainerId = new Map<string, any>();
  const textById = new Map<string, any>();
  const looseTexts: any[] = [];

  for (const el of active) {
    if (el.type !== "text") {
      continue;
    }
    textById.set(el.id, el);
    if (el.containerId) {
      boundTextByContainerId.set(el.containerId, el);
    } else {
      looseTexts.push(el);
    }
  }
  return { boundTextByContainerId, textById, looseTexts };
}

function readTextContent(textEl: any): string {
  if (!textEl) {
    return "";
  }
  const orig =
    typeof textEl.originalText === "string" ? textEl.originalText.trim() : "";
  if (orig) {
    return orig;
  }
  return typeof textEl.text === "string" ? textEl.text.trim() : "";
}

function tryExtractSequence(
  active: any[],
  boundTextByContainerId: Map<string, any>,
  looseTexts: any[],
): SequenceModel | null {
  const topRects = active.filter((el) => {
    if (el.type !== "rectangle") {
      return false;
    }
    const meta = getSyncMeta(el);
    if (meta?.diagramKind === "sequence" && meta.role === "actor-top") {
      return true;
    }
    if (typeof el.id === "string" && el.id.endsWith("-top")) {
      const base = el.id.slice(0, -4);
      return active.some(
        (other) => other.type === "rectangle" && other.id === `${base}-bottom`,
      );
    }
    return false;
  });

  if (topRects.length < 2) {
    return null;
  }

  topRects.sort((a, b) => (a.x ?? 0) - (b.x ?? 0));
  const usedIds = new Set<string>();
  const participants: Array<{ id: string; label: string; cx: number }> = [];

  for (const rect of topRects) {
    const meta = getSyncMeta(rect);
    const rawBase =
      meta?.participantId ||
      (typeof rect.id === "string" ? rect.id.replace(/-top$/, "") : "P");
    const bottomRect = active.find(
      (el) =>
        el.type === "rectangle" &&
        (el.id === `${rawBase}-bottom` ||
          (getSyncMeta(el)?.diagramKind === "sequence" &&
            getSyncMeta(el)?.role === "actor-bottom" &&
            getSyncMeta(el)?.participantId === rawBase)),
    );
    const topLabel = readTextContent(boundTextByContainerId.get(rect.id));
    const bottomLabel = bottomRect
      ? readTextContent(boundTextByContainerId.get(bottomRect.id))
      : "";
    const label = topLabel || bottomLabel || meta?.label || rawBase;
    const id = sanitizeIdentifier(rawBase, usedIds, "P");
    participants.push({
      id,
      label,
      cx: elementCenter(rect).x,
    });
  }

  const nearestParticipantId = (worldX: number): string => {
    let best = participants[0];
    let bestDist = Math.abs(worldX - best.cx);
    for (let i = 1; i < participants.length; i += 1) {
      const d = Math.abs(worldX - participants[i].cx);
      if (d < bestDist) {
        best = participants[i];
        bestDist = d;
      }
    }
    return best.id;
  };

  const claimedTextIds = new Set<string>();
  const arrows = active
    .filter((el) => el.type === "arrow")
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));

  const messages: SequenceMessage[] = [];
  for (const arr of arrows) {
    const pts: Array<[number, number]> =
      Array.isArray(arr.points) && arr.points.length >= 2
        ? arr.points
        : [
            [0, 0],
            [arr.width || 0, arr.height || 0],
          ];
    const startX = (arr.x || 0) + pts[0][0];
    const endX = (arr.x || 0) + pts[pts.length - 1][0];
    const from = nearestParticipantId(startX);
    const to = nearestParticipantId(endX);

    let label = readTextContent(boundTextByContainerId.get(arr.id));
    if (!label) {
      const midX = (startX + endX) / 2;
      const midY = (arr.y || 0) + (pts[0][1] + pts[pts.length - 1][1]) / 2;
      let bestText: any = null;
      let bestDist = 42;
      for (const lt of looseTexts) {
        if (claimedTextIds.has(lt.id)) {
          continue;
        }
        const c = elementCenter(lt);
        const d = Math.hypot(c.x - midX, c.y - midY);
        if (d < bestDist) {
          bestDist = d;
          bestText = lt;
        }
      }
      if (bestText) {
        claimedTextIds.add(bestText.id);
        label = readTextContent(bestText);
      }
    }

    const style =
      arr.strokeStyle === "dotted" || arr.strokeStyle === "dashed"
        ? "dashed"
        : "solid";
    messages.push({ from, to, label: label || "message", style });
  }

  return {
    kind: "sequence",
    participants: participants.map(({ id, label }) => ({ id, label })),
    messages,
  };
}

export function extractDiagramFromExcalidraw(
  elements: readonly any[],
): DiagramModel {
  const active = (elements || []).filter((el) => el && !el.isDeleted);
  const { boundTextByContainerId, textById, looseTexts } = buildTextLookups(active);

  const seq = tryExtractSequence(active, boundTextByContainerId, looseTexts);
  if (seq) {
    return seq;
  }

  const claimedTextIds = new Set<string>();
  const titleBandTextByParent = new Map<string, string>();
  const titleBandIds = new Set<string>();

  const rawShapes = active.filter(
    (el) =>
      el.type === "rectangle" ||
      el.type === "ellipse" ||
      el.type === "diamond" ||
      el.type === "frame",
  );

  // Merge double-circle helper ellipses emitted by @excalidraw/mermaid-to-excalidraw
  const suppressedIds = new Set<string>();
  const inheritedTextById = new Map<string, string>();
  const doubleCircleGroups = new Map<string, any[]>();
  for (const el of rawShapes) {
    if (el.type !== "ellipse" || !Array.isArray(el.groupIds)) {
      continue;
    }
    const dcGroup = el.groupIds.find(
      (g: unknown) => typeof g === "string" && g.startsWith("doublecircle_"),
    );
    if (dcGroup) {
      const list = doubleCircleGroups.get(dcGroup) || [];
      list.push(el);
      doubleCircleGroups.set(dcGroup, list);
    }
  }
  for (const groupEls of doubleCircleGroups.values()) {
    if (groupEls.length > 1) {
      groupEls.sort((a, b) => elementArea(b) - elementArea(a));
      const outer = groupEls[0];
      for (let i = 1; i < groupEls.length; i += 1) {
        const inner = groupEls[i];
        suppressedIds.add(inner.id);
        const innerTxt = readTextContent(boundTextByContainerId.get(inner.id));
        if (innerTxt && !readTextContent(boundTextByContainerId.get(outer.id))) {
          inheritedTextById.set(outer.id, innerTxt);
        }
      }
    }
  }

  // Filter subgraph title bands (e.g. `sg1__title` or transparent top strip rects)
  for (const el of rawShapes) {
    if (el.type !== "rectangle" || suppressedIds.has(el.id)) {
      continue;
    }
    const isExplicitTitle =
      typeof el.id === "string" && el.id.endsWith("__title");
    const isTransparentBand =
      el.strokeColor === "transparent" && boundTextByContainerId.has(el.id);

    if (!isExplicitTitle && !isTransparentBand) {
      continue;
    }
    const center = elementCenter(el);
    const enclosing = rawShapes
      .filter(
        (other) =>
          other.id !== el.id &&
          other.type === "rectangle" &&
          elementArea(other) > elementArea(el) * 1.4 &&
          rectContainsPoint(other, center, 2),
      )
      .sort((a, b) => elementArea(a) - elementArea(b));

    if (isExplicitTitle || enclosing.length > 0) {
      titleBandIds.add(el.id);
      const txt = readTextContent(boundTextByContainerId.get(el.id));
      const explicitParent = isExplicitTitle
        ? el.id.slice(0, -"__title".length)
        : null;
      const parentId = enclosing[0]?.id || explicitParent;
      if (parentId && txt) {
        titleBandTextByParent.set(parentId, txt);
      }
    }
  }

  const cleanShapes = rawShapes.filter(
    (el) => !suppressedIds.has(el.id) && !titleBandIds.has(el.id),
  );

  // Separate subgraphs (frames or large enclosing rectangles) from leaf nodes
  const subgraphRawSet = new Set<string>();
  for (const el of cleanShapes) {
    if (el.type === "frame" || getSyncMeta(el)?.isSubgraph) {
      subgraphRawSet.add(el.id);
      continue;
    }
    if (el.type !== "rectangle") {
      continue;
    }
    const myArea = elementArea(el);
    const hasChildShape = cleanShapes.some((other) => {
      if (other.id === el.id || other.type === "frame") {
        return false;
      }
      const otherArea = elementArea(other);
      return (
        myArea >= otherArea * 1.8 &&
        rectContainsPoint(el, elementCenter(other), 0)
      );
    });
    if (hasChildShape) {
      subgraphRawSet.add(el.id);
    }
  }

  const usedIds = new Set<string>();
  const subgraphEls = cleanShapes
    .filter((el) => subgraphRawSet.has(el.id))
    .sort((a, b) => (a.y ?? 0) - (b.y ?? 0) || (a.x ?? 0) - (b.x ?? 0));

  const subgraphByRawId = new Map<
    string,
    { el: any; id: string; label: string }
  >();
  const subgraphs: FlowSubgraph[] = [];

  for (const sg of subgraphEls) {
    const meta = getSyncMeta(sg);
    let label =
      titleBandTextByParent.get(sg.id) ||
      readTextContent(boundTextByContainerId.get(sg.id)) ||
      "";
    if (!label && sg.type === "frame" && typeof sg.name === "string") {
      label = sg.name.trim();
    }
    if (!label) {
      const topStripTexts = looseTexts
        .filter((lt) => {
          if (claimedTextIds.has(lt.id)) {
            return false;
          }
          const c = elementCenter(lt);
          return (
            c.x >= (sg.x || 0) &&
            c.x <= (sg.x || 0) + (sg.width || 0) &&
            c.y >= (sg.y || 0) &&
            c.y <= (sg.y || 0) + 56
          );
        })
        .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
      if (topStripTexts.length > 0) {
        claimedTextIds.add(topStripTexts[0].id);
        label = readTextContent(topStripTexts[0]);
      }
    }
    if (!label && meta?.label) {
      label = meta.label;
    }

    const rawIdHint = meta?.nodeId || sg.id;
    const baseName =
      meta?.nodeId ||
      (!looksLikeRandomExcalidrawId(String(rawIdHint)) &&
      /^[A-Za-z0-9_-]{1,28}$/.test(String(rawIdHint))
        ? String(rawIdHint)
        : label || "Group");
    const sgId = sanitizeIdentifier(baseName, usedIds, "sg");
    const finalLabel = label || sgId;
    subgraphByRawId.set(sg.id, { el: sg, id: sgId, label: finalLabel });
    subgraphs.push({ id: sgId, label: finalLabel });
  }

  const nodeEls = cleanShapes
    .filter((el) => !subgraphRawSet.has(el.id))
    .sort(
      (a, b) =>
        Math.round((a.y ?? 0) / 20) - Math.round((b.y ?? 0) / 20) ||
        (a.x ?? 0) - (b.x ?? 0),
    );

  const nodeByRawId = new Map<
    string,
    { el: any; node: FlowNode }
  >();
  const nodes: FlowNode[] = [];

  for (const el of nodeEls) {
    const meta = getSyncMeta(el);
    let label =
      readTextContent(boundTextByContainerId.get(el.id)) ||
      inheritedTextById.get(el.id) ||
      "";
    if (!label) {
      const insideLoose = looseTexts
        .filter((lt) => {
          if (claimedTextIds.has(lt.id)) {
            return false;
          }
          return rectContainsPoint(el, elementCenter(lt), 4);
        })
        .sort((a, b) => {
          const ca = elementCenter(a);
          const cb = elementCenter(b);
          const ce = elementCenter(el);
          return (
            Math.hypot(ca.x - ce.x, ca.y - ce.y) -
            Math.hypot(cb.x - ce.x, cb.y - ce.y)
          );
        });
      if (insideLoose.length > 0) {
        claimedTextIds.add(insideLoose[0].id);
        label = readTextContent(insideLoose[0]);
      }
    }
    if (!label && meta?.label) {
      label = meta.label;
    }

    const shortRawId =
      typeof el.id === "string" &&
      /^[A-Za-z][A-Za-z0-9_]{0,16}$/.test(el.id) &&
      !looksLikeRandomExcalidrawId(el.id)
        ? el.id
        : null;
    const firstLine = label.split("\n")[0].replace(/^\d+\.\s*/, "").trim();
    const idSeed = meta?.nodeId || shortRawId || firstLine || el.id || "Node";
    const nodeId = sanitizeIdentifier(idSeed, usedIds, "N");
    const finalLabel = label || nodeId;

    let shape: FlowShape = "rectangle";
    if (el.type === "diamond") {
      shape = "diamond";
    } else if (el.type === "ellipse") {
      shape = "ellipse";
    } else if (el.type === "rectangle") {
      if (
        meta?.shape === "database" ||
        meta?.shape === "subroutine" ||
        meta?.shape === "rounded" ||
        meta?.shape === "rectangle"
      ) {
        shape = meta.shape;
      } else if (meta?.synced && el.roundness) {
        shape = "rounded";
      }
    }

    let subgraphId: string | undefined;
    if (el.frameId && subgraphByRawId.has(el.frameId)) {
      subgraphId = subgraphByRawId.get(el.frameId)!.id;
    } else {
      const center = elementCenter(el);
      const enclosingSgs = Array.from(subgraphByRawId.values())
        .filter((sg) => rectContainsPoint(sg.el, center, 0))
        .sort((a, b) => elementArea(a.el) - elementArea(b.el));
      if (enclosingSgs.length > 0) {
        subgraphId = enclosingSgs[0].id;
      }
    }

    const bgColor = isCustomHexColor(el.backgroundColor)
      ? el.backgroundColor
      : meta?.bgColor;
    const strokeColor =
      meta?.strokeColor ||
      (isCustomStrokeColor(el.strokeColor) ? el.strokeColor : undefined);

    const node: FlowNode = {
      id: nodeId,
      label: finalLabel,
      shape,
      ...(subgraphId ? { subgraphId } : {}),
      ...(bgColor ? { bgColor } : {}),
      ...(strokeColor ? { strokeColor } : {}),
    };
    nodeByRawId.set(el.id, { el, node });
    nodes.push(node);
  }

  const resolveEndpoint = (
    bindingElId: unknown,
    worldPt: { x: number; y: number },
  ): { nodeId: string; center: { x: number; y: number } } | null => {
    if (typeof bindingElId === "string" && bindingElId) {
      let targetId = bindingElId;
      const boundText = textById.get(bindingElId);
      if (boundText?.containerId) {
        targetId = boundText.containerId;
      }
      const direct = nodeByRawId.get(targetId);
      if (direct) {
        return { nodeId: direct.node.id, center: elementCenter(direct.el) };
      }
    }

    let best: { el: any; node: FlowNode } | null = null;
    let bestDist = 42;
    for (const entry of nodeByRawId.values()) {
      const d = distancePointToRect(entry.el, worldPt);
      if (d < bestDist) {
        bestDist = d;
        best = entry;
      }
    }
    return best
      ? { nodeId: best.node.id, center: elementCenter(best.el) }
      : null;
  };

  const edgeElements = active.filter(
    (el) => el.type === "arrow" || el.type === "line",
  );
  const edges: FlowEdge[] = [];
  let sumDx = 0;
  let sumDy = 0;

  for (const el of edgeElements) {
    const pts: Array<[number, number]> =
      Array.isArray(el.points) && el.points.length >= 2
        ? el.points
        : [
            [0, 0],
            [el.width || 0, el.height || 0],
          ];
    const startPt = {
      x: (el.x || 0) + pts[0][0],
      y: (el.y || 0) + pts[0][1],
    };
    const endPt = {
      x: (el.x || 0) + pts[pts.length - 1][0],
      y: (el.y || 0) + pts[pts.length - 1][1],
    };

    const startTarget = resolveEndpoint(el.startBinding?.elementId, startPt);
    const endTarget = resolveEndpoint(el.endBinding?.elementId, endPt);

    if (!startTarget || !endTarget) {
      continue;
    }
    if (
      startTarget.nodeId === endTarget.nodeId &&
      el.startBinding?.elementId !== el.endBinding?.elementId
    ) {
      continue;
    }

    let from = startTarget.nodeId;
    let to = endTarget.nodeId;
    let fromCenter = startTarget.center;
    let toCenter = endTarget.center;

    const hasStartHead = el.type === "arrow" && el.startArrowhead != null;
    const hasEndHead = el.type === "arrow" && el.endArrowhead != null;
    const bidirectional = hasStartHead && hasEndHead;
    const undirected = el.type === "line" || (!hasStartHead && !hasEndHead);

    if (hasStartHead && !hasEndHead) {
      from = endTarget.nodeId;
      to = startTarget.nodeId;
      fromCenter = endTarget.center;
      toCenter = startTarget.center;
    }

    sumDx += toCenter.x - fromCenter.x;
    sumDy += toCenter.y - fromCenter.y;

    let label = readTextContent(boundTextByContainerId.get(el.id));
    if (!label) {
      const midPt = pts[Math.floor(pts.length / 2)];
      const midWorld = {
        x: (el.x || 0) + midPt[0],
        y: (el.y || 0) + midPt[1],
      };
      let bestText: any = null;
      let bestDist = 34;
      for (const lt of looseTexts) {
        if (claimedTextIds.has(lt.id)) {
          continue;
        }
        const c = elementCenter(lt);
        const d = Math.hypot(c.x - midWorld.x, c.y - midWorld.y);
        if (d < bestDist) {
          bestDist = d;
          bestText = lt;
        }
      }
      if (bestText) {
        claimedTextIds.add(bestText.id);
        label = readTextContent(bestText);
      }
    }

    const style: EdgeStyle =
      el.strokeStyle === "dashed" || el.strokeStyle === "dotted"
        ? "dashed"
        : Number(el.strokeWidth) >= 3.5
          ? "thick"
          : "solid";

    edges.push({
      from,
      to,
      ...(label ? { label } : {}),
      style,
      ...(bidirectional ? { bidirectional: true } : {}),
      ...(undirected ? { undirected: true } : {}),
    });
  }

  let direction: FlowDirection = "TD";
  if (edges.length > 0) {
    if (Math.abs(sumDx) >= Math.abs(sumDy) * 1.1) {
      direction = sumDx < 0 ? "RL" : "LR";
    } else {
      direction = sumDy < 0 ? "BT" : "TD";
    }
  } else if (nodes.length >= 2) {
    const xs = nodeEls.map((e) => e.x || 0);
    const x2s = nodeEls.map((e) => (e.x || 0) + (e.width || 0));
    const ys = nodeEls.map((e) => e.y || 0);
    const y2s = nodeEls.map((e) => (e.y || 0) + (e.height || 0));
    const spanX = Math.max(...x2s) - Math.min(...xs);
    const spanY = Math.max(...y2s) - Math.min(...ys);
    direction = spanX > spanY * 1.15 ? "LR" : "TD";
  }

  return {
    kind: "flowchart",
    direction,
    subgraphs,
    nodes,
    edges,
  };
}

function escapePlantUmlText(raw: string): string {
  return raw.trim().replace(/"/g, "'").replace(/\r?\n/g, "\\n");
}

function plantUmlKeywordForShape(shape: FlowShape): string {
  switch (shape) {
    case "rounded":
      return "card";
    case "diamond":
      return "hexagon";
    case "ellipse":
      return "usecase";
    case "database":
      return "database";
    case "subroutine":
      return "component";
    case "rectangle":
    default:
      return "rectangle";
  }
}

function formatPlantUmlNode(node: FlowNode): string {
  const kw = plantUmlKeywordForShape(node.shape);
  const lbl = escapePlantUmlText(node.label);
  const color = isCustomHexColor(node.bgColor) ? ` ${node.bgColor}` : "";
  return `${kw} "${lbl}" as ${node.id}${color}`;
}

function formatPlantUmlEdge(edge: FlowEdge): string {
  let op = "-->";
  if (edge.bidirectional) {
    op = edge.style === "dashed" ? "<..>" : edge.style === "thick" ? "<==>" : "<-->";
  } else if (edge.undirected) {
    op = edge.style === "dashed" ? ".." : edge.style === "thick" ? "==" : "--";
  } else {
    op = edge.style === "dashed" ? "..>" : edge.style === "thick" ? "==>" : "-->";
  }
  const lbl = edge.label ? ` : ${escapePlantUmlText(edge.label)}` : "";
  return `${edge.from} ${op} ${edge.to}${lbl}`;
}

export function serializePlantUml(model: DiagramModel): string {
  if (model.kind === "sequence") {
    const lines: string[] = ["@startuml"];
    for (const p of model.participants) {
      const kw = p.actor ? "actor" : "participant";
      const lbl = escapePlantUmlText(p.label).replace(/\\n/g, " ");
      lines.push(`${kw} "${lbl}" as ${p.id}`);
    }
    for (const msg of model.messages) {
      const arrow = msg.style === "dashed" ? "-->" : "->";
      const lbl = escapePlantUmlText(msg.label || "message").replace(/\\n/g, " ");
      lines.push(`${msg.from} ${arrow} ${msg.to} : ${lbl}`);
    }
    lines.push("@enduml");
    return `${lines.join("\n")}\n`;
  }

  const lines: string[] = ["@startuml"];
  if (model.direction === "LR" || model.direction === "RL") {
    lines.push("left to right direction");
  } else {
    lines.push("top to bottom direction");
  }

  const nodesBySubgraph = new Map<string, FlowNode[]>();
  const topNodes: FlowNode[] = [];

  for (const n of model.nodes) {
    if (n.subgraphId) {
      const arr = nodesBySubgraph.get(n.subgraphId) || [];
      arr.push(n);
      nodesBySubgraph.set(n.subgraphId, arr);
    } else {
      topNodes.push(n);
    }
  }

  for (const sg of model.subgraphs) {
    const lbl = escapePlantUmlText(sg.label);
    lines.push(`package "${lbl}" as ${sg.id} {`);
    for (const n of nodesBySubgraph.get(sg.id) || []) {
      lines.push(`  ${formatPlantUmlNode(n)}`);
    }
    lines.push("}");
  }

  for (const n of topNodes) {
    lines.push(formatPlantUmlNode(n));
  }

  for (const edge of model.edges) {
    lines.push(formatPlantUmlEdge(edge));
  }

  lines.push("@enduml");
  return `${lines.join("\n")}\n`;
}

export function excalidrawToMermaid(elements: readonly any[]): string {
  return serializeMermaid(extractDiagramFromExcalidraw(elements));
}

export function excalidrawToPlantUml(elements: readonly any[]): string {
  return serializePlantUml(extractDiagramFromExcalidraw(elements));
}

function scanMermaidHints(code: string) {
  const shapes = new Map<string, FlowShape>();
  const bgColors = new Map<string, string>();
  const strokeColors = new Map<string, string>();

  for (const rawLine of code.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) {
      continue;
    }
    const styleMatch = line.match(/^style\s+([A-Za-z][A-Za-z0-9_]*)\s+(.+)$/);
    if (styleMatch) {
      const id = styleMatch[1];
      const props = styleMatch[2].split(",");
      for (const prop of props) {
        const [k, v] = prop.split(":").map((s) => s.trim());
        if (k === "fill" && isCustomHexColor(v)) {
          bgColors.set(id, v);
        }
        if (k === "stroke" && isCustomStrokeColor(v)) {
          strokeColors.set(id, v);
        }
      }
      continue;
    }

    const dbMatches = line.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*\[\(/g);
    for (const m of dbMatches) {
      shapes.set(m[1], "database");
    }
    const subMatches = line.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\s*\[\[/g);
    for (const m of subMatches) {
      shapes.set(m[1], "subroutine");
    }
    const roundedMatches = line.matchAll(/\b([A-Za-z][A-Za-z0-9_]*)\((?!\()/g);
    for (const m of roundedMatches) {
      if (!shapes.has(m[1])) {
        shapes.set(m[1], "rounded");
      }
    }
  }

  return { shapes, bgColors, strokeColors };
}

function collectExistingStyles(existingElements: readonly any[]): Map<
  string,
  { backgroundColor?: string; strokeColor?: string }
> {
  const styles = new Map<string, { backgroundColor?: string; strokeColor?: string }>();
  for (const el of existingElements) {
    if (!el || el.isDeleted) {
      continue;
    }
    if (el.type !== "rectangle" && el.type !== "ellipse" && el.type !== "diamond") {
      continue;
    }
    const meta = getSyncMeta(el);
    const key = meta?.nodeId || el.id;
    const entry: { backgroundColor?: string; strokeColor?: string } = {};
    if (isCustomHexColor(el.backgroundColor)) {
      entry.backgroundColor = el.backgroundColor;
    }
    if (isCustomStrokeColor(el.strokeColor)) {
      entry.strokeColor = el.strokeColor;
    }
    if (entry.backgroundColor || entry.strokeColor) {
      styles.set(key, entry);
      if (el.id && el.id !== key) {
        styles.set(el.id, entry);
      }
    }
  }
  return styles;
}

function dedupeSkeletonIds(skeletons: any[]): any[] {
  const used = new Set<string>();
  return skeletons.map((sk) => {
    if (!sk || typeof sk.id !== "string" || !sk.id) {
      return sk;
    }
    let id = sk.id;
    if (used.has(id)) {
      let i = 2;
      while (used.has(`${id}_${i}`)) {
        i += 1;
      }
      id = `${id}_${i}`;
    }
    used.add(id);
    return id === sk.id ? sk : { ...sk, id };
  });
}

async function parseMermaidToSkeleton(mermaidCode: string) {
  try {
    return await parseMermaidToExcalidraw(mermaidCode);
  } catch (err) {
    if (!mermaidCode.includes('"')) {
      throw err;
    }
    return await parseMermaidToExcalidraw(mermaidCode.replace(/"/g, "'"));
  }
}

export async function mermaidToExcalidraw(
  mermaidCode: string,
  existingElements: readonly any[] = [],
  hints?: {
    shapes?: Map<string, FlowShape>;
    bgColors?: Map<string, string>;
    strokeColors?: Map<string, string>;
  },
): Promise<any[]> {
  const trimmed = mermaidCode.trim();
  if (!trimmed) {
    throw new Error("Mermaid input is empty");
  }

  const result = await parseMermaidToSkeleton(trimmed);
  const rawSkeletons = Array.isArray(result?.elements) ? result.elements : [];
  if (rawSkeletons.length === 0) {
    throw new Error("Mermaid parser returned no elements");
  }

  // @excalidraw/mermaid-to-excalidraw falls back to a GraphImage for unsupported/broken syntax
  if (rawSkeletons.some((el: any) => el?.type === "image")) {
    throw new Error(
      "Unsupported Mermaid diagram type or syntax (image fallback rejected for two-way sync)",
    );
  }

  const isSequence = /^\s*sequenceDiagram\b/m.test(trimmed);
  const scanned = scanMermaidHints(trimmed);
  const shapeHints = hints?.shapes ?? scanned.shapes;
  const bgHints = hints?.bgColors ?? scanned.bgColors;
  const strokeHints = hints?.strokeColors ?? scanned.strokeColors;
  const existingStyles = collectExistingStyles(existingElements);

  const dedupedSkeletons = dedupeSkeletonIds(rawSkeletons);
  const converted = convertToExcalidrawElements(dedupedSkeletons as any, {
    regenerateIds: false,
  });

  const subgraphsDetected = new Set<string>();
  for (const el of converted) {
    if (typeof el.id === "string" && el.id.endsWith("__title")) {
      subgraphsDetected.add(el.id.slice(0, -"__title".length));
    }
  }

  const syncedGraphElements = converted.map((el: any) => {
    const idStr = typeof el.id === "string" ? el.id : "";
    const meta: DiagramSyncMeta = {
      synced: true,
      diagramKind: isSequence ? "sequence" : "flowchart",
    };

    if (isSequence) {
      if (el.type === "rectangle" && idStr.endsWith("-top")) {
        meta.role = "actor-top";
        meta.participantId = idStr.slice(0, -4);
      } else if (el.type === "rectangle" && idStr.endsWith("-bottom")) {
        meta.role = "actor-bottom";
        meta.participantId = idStr.slice(0, -7);
      } else if (el.type === "line") {
        meta.role = "lifeline";
      } else if (el.type === "arrow") {
        meta.role = "message";
      }
      return { ...el, customData: { ...el.customData, diagramSync: meta } };
    }

    if (
      (el.type === "rectangle" ||
        el.type === "ellipse" ||
        el.type === "diamond") &&
      !idStr.endsWith("__title")
    ) {
      if (subgraphsDetected.has(idStr)) {
        meta.isSubgraph = true;
      }
      meta.nodeId = idStr;
      const hintedShape = shapeHints.get(idStr);
      if (hintedShape) {
        meta.shape = hintedShape;
      } else if (el.type === "diamond") {
        meta.shape = "diamond";
      } else if (el.type === "ellipse") {
        meta.shape = "ellipse";
      } else {
        meta.shape = "rectangle";
      }

      const explicitBg = bgHints.get(idStr);
      const explicitStroke = strokeHints.get(idStr);
      const prevStyle = existingStyles.get(idStr);

      let nextBg = el.backgroundColor;
      let nextStroke = el.strokeColor;
      if (explicitBg) {
        nextBg = explicitBg;
        meta.bgColor = explicitBg;
      } else if (prevStyle?.backgroundColor && !subgraphsDetected.has(idStr)) {
        nextBg = prevStyle.backgroundColor;
        meta.bgColor = prevStyle.backgroundColor;
      }

      if (explicitStroke) {
        nextStroke = explicitStroke;
        meta.strokeColor = explicitStroke;
      } else if (prevStyle?.strokeColor && !subgraphsDetected.has(idStr)) {
        nextStroke = prevStyle.strokeColor;
        meta.strokeColor = prevStyle.strokeColor;
      }

      return {
        ...el,
        backgroundColor: nextBg,
        strokeColor: nextStroke,
        customData: { ...el.customData, diagramSync: meta },
      };
    }

    return {
      ...el,
      customData: { ...el.customData, diagramSync: meta },
    };
  });

  // Preserve non-diagram canvas items (freehand sketches, embedded images, etc.)
  const preservedExtras = existingElements.filter(
    (el) => el && !el.isDeleted && !GRAPH_ELEMENT_TYPES.has(el.type),
  );

  return [...preservedExtras, ...syncedGraphElements];
}

export async function plantUmlToExcalidraw(
  plantUmlCode: string,
  existingElements: readonly any[] = [],
): Promise<{ model: DiagramModel; elements: any[]; mermaid: string }> {
  const model = parsePlantUml(plantUmlCode);
  const mermaid = serializeMermaid(model);

  const hints =
    model.kind === "flowchart"
      ? {
          shapes: new Map(model.nodes.map((n) => [n.id, n.shape])),
          bgColors: new Map(
            model.nodes
              .filter((n) => isCustomHexColor(n.bgColor))
              .map((n) => [n.id, n.bgColor!]),
          ),
          strokeColors: new Map(
            model.nodes
              .filter((n) => isCustomStrokeColor(n.strokeColor))
              .map((n) => [n.id, n.strokeColor!]),
          ),
        }
      : undefined;

  const elements = await mermaidToExcalidraw(mermaid, existingElements, hints);
  return { model, elements, mermaid };
}
