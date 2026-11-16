export type FlowDirection = "TD" | "LR" | "BT" | "RL";
export type FlowShape =
  | "rectangle"
  | "rounded"
  | "diamond"
  | "ellipse"
  | "database"
  | "subroutine";
export type EdgeStyle = "solid" | "dashed" | "thick";

export interface FlowSubgraph {
  id: string;
  label: string;
}

export interface FlowNode {
  id: string;
  label: string;
  shape: FlowShape;
  subgraphId?: string;
  bgColor?: string;
  strokeColor?: string;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  style: EdgeStyle;
  bidirectional?: boolean;
  undirected?: boolean;
}

export interface FlowGraphModel {
  kind: "flowchart";
  direction: FlowDirection;
  subgraphs: FlowSubgraph[];
  nodes: FlowNode[];
  edges: FlowEdge[];
}

export interface SequenceParticipant {
  id: string;
  label: string;
  actor?: boolean;
}

export interface SequenceMessage {
  from: string;
  to: string;
  label: string;
  style: "solid" | "dashed";
}

export interface SequenceModel {
  kind: "sequence";
  participants: SequenceParticipant[];
  messages: SequenceMessage[];
}

export type DiagramModel = FlowGraphModel | SequenceModel;

export const PLANTUML_EXAMPLE = `@startuml
left to right direction
package "Backend Tier" as backend {
  rectangle "Auth Check" as auth #e7f5ff
  database "Postgres DB" as db
}
usecase "Browser UI" as ui
ui ..> auth : HTTPS
auth --> db : SQL
@enduml`;

const MERMAID_RESERVED = new Set([
  "end",
  "subgraph",
  "graph",
  "flowchart",
  "style",
  "class",
  "classdef",
  "click",
  "direction",
  "linkstyle",
]);

export function isPlantUmlDefinition(text: string): boolean {
  const firstMeaningfulLine = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("'"));
  return Boolean(firstMeaningfulLine && /^@startuml\b/i.test(firstMeaningfulLine));
}

export function isCustomHexColor(color: unknown): color is string {
  if (typeof color !== "string") {
    return false;
  }
  const c = color.trim().toLowerCase();
  if (!/^#[0-9a-f]{3,8}$/.test(c)) {
    return false;
  }
  return c !== "#ffffff" && c !== "#fff" && c !== "#000000" && c !== "transparent";
}

export function isCustomStrokeColor(color: unknown): color is string {
  if (typeof color !== "string") {
    return false;
  }
  const c = color.trim().toLowerCase();
  if (!/^#[0-9a-f]{3,8}$/.test(c)) {
    return false;
  }
  return c !== "#1e1e1e" && c !== "#000000" && c !== "#000" && c !== "transparent";
}

export function sanitizeIdentifier(
  raw: string,
  used?: Set<string>,
  fallbackPrefix = "Node",
): string {
  let clean = raw
    .trim()
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_");
  if (!clean) {
    clean = fallbackPrefix;
  }
  if (!/^[A-Za-z]/.test(clean)) {
    clean = `${fallbackPrefix}_${clean}`;
  }
  if (clean.length > 28) {
    clean = clean.slice(0, 28).replace(/_+$/g, "");
  }
  if (MERMAID_RESERVED.has(clean.toLowerCase())) {
    clean = `${clean}_node`;
  }
  if (!used) {
    return clean;
  }
  let candidate = clean;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${clean}_${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function escapeMermaidText(raw: string): string {
  return raw.trim().replace(/"/g, "'").replace(/\r?\n/g, "<br/>");
}

function escapeMermaidEdgeLabel(raw: string): string {
  return escapeMermaidText(raw).replace(/\|/g, "/");
}

function formatMermaidNode(node: FlowNode): string {
  const lbl = escapeMermaidText(node.label);
  switch (node.shape) {
    case "rounded":
      return `${node.id}("${lbl}")`;
    case "diamond":
      return `${node.id}{"${lbl}"}`;
    case "ellipse":
      return `${node.id}(("${lbl}"))`;
    case "database":
      return `${node.id}[("${lbl}")]`;
    case "subroutine":
      return `${node.id}[["${lbl}"]]`;
    case "rectangle":
    default:
      return `${node.id}["${lbl}"]`;
  }
}

function formatMermaidEdge(edge: FlowEdge): string {
  let op = "-->";
  if (edge.bidirectional) {
    op = edge.style === "dashed" ? "<-.->" : "<-->";
  } else if (edge.undirected) {
    op = edge.style === "dashed" ? "-.-" : edge.style === "thick" ? "===" : "---";
  } else {
    op = edge.style === "dashed" ? "-.->" : edge.style === "thick" ? "==>" : "-->";
  }
  const lbl = edge.label ? `|"${escapeMermaidEdgeLabel(edge.label)}"|` : "";
  return `${edge.from} ${op}${lbl} ${edge.to}`;
}

export function serializeMermaid(model: DiagramModel): string {
  if (model.kind === "sequence") {
    const lines: string[] = ["sequenceDiagram"];
    for (const p of model.participants) {
      const keyword = p.actor ? "actor" : "participant";
      const lbl = escapeMermaidText(p.label).replace(/<br\/>/g, " ");
      if (lbl === p.id) {
        lines.push(`  ${keyword} ${p.id}`);
      } else {
        lines.push(`  ${keyword} ${p.id} as ${lbl}`);
      }
    }
    for (const msg of model.messages) {
      const arrow = msg.style === "dashed" ? "-->>" : "->>";
      const lbl = escapeMermaidText(msg.label || "message").replace(/<br\/>/g, " ");
      lines.push(`  ${msg.from}${arrow}${msg.to}: ${lbl}`);
    }
    return `${lines.join("\n")}\n`;
  }

  const lines: string[] = [`flowchart ${model.direction}`];
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
    const lbl = escapeMermaidText(sg.label);
    lines.push(`  subgraph ${sg.id}["${lbl}"]`);
    const children = nodesBySubgraph.get(sg.id) || [];
    for (const n of children) {
      lines.push(`    ${formatMermaidNode(n)}`);
    }
    lines.push("  end");
  }

  for (const n of topNodes) {
    lines.push(`  ${formatMermaidNode(n)}`);
  }

  for (const edge of model.edges) {
    lines.push(`  ${formatMermaidEdge(edge)}`);
  }

  for (const n of model.nodes) {
    const styleParts: string[] = [];
    if (isCustomHexColor(n.bgColor)) {
      styleParts.push(`fill:${n.bgColor}`);
    }
    if (isCustomStrokeColor(n.strokeColor)) {
      styleParts.push(`stroke:${n.strokeColor}`);
    }
    if (styleParts.length > 0) {
      lines.push(`  style ${n.id} ${styleParts.join(",")}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function decodePlantUmlEscapes(text: string): string {
  return text.replace(/\\n/g, "\n").trim();
}

function unquoteEndpointToken(token: string): {
  idRaw: string;
  label?: string;
  shorthandShape?: FlowShape;
} {
  const t = token.trim();
  if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) {
    const inner = decodePlantUmlEscapes(t.slice(1, -1));
    return { idRaw: inner, label: inner };
  }
  if (t.startsWith("[") && t.endsWith("]") && t.length >= 2) {
    const inner = decodePlantUmlEscapes(t.slice(1, -1));
    return { idRaw: inner, label: inner, shorthandShape: "rectangle" };
  }
  if (t.startsWith("(") && t.endsWith(")") && t.length >= 2) {
    const inner = decodePlantUmlEscapes(t.slice(1, -1));
    return { idRaw: inner, label: inner, shorthandShape: "ellipse" };
  }
  return { idRaw: t };
}

function mapPlantUmlKeywordShape(kw: string): FlowShape {
  switch (kw.toLowerCase()) {
    case "card":
      return "rounded";
    case "hexagon":
    case "diamond":
    case "cond":
      return "diamond";
    case "circle":
    case "ellipse":
    case "usecase":
    case "actor":
      return "ellipse";
    case "database":
    case "storage":
      return "database";
    case "component":
      return "subroutine";
    default:
      return "rectangle";
  }
}

export function parsePlantUml(code: string): DiagramModel {
  const normalized = code.replace(/\r\n/g, "\n");
  if (!normalized.trim()) {
    throw new Error("PlantUML input is empty");
  }

  const lines = normalized.split("\n");
  let inBlockComment = false;
  let skipBlockDepth = 0;

  let direction: FlowDirection = "TD";
  const subgraphs: FlowSubgraph[] = [];
  const subgraphStack: string[] = [];
  const nodeMap = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];

  let forceSequence = false;
  let forceFlowchart = false;
  const seqParticipants = new Map<string, SequenceParticipant>();
  const seqMessages: SequenceMessage[] = [];
  const rawArrowRecords: Array<{
    fromId: string;
    toId: string;
    label: string;
    op: string;
    singleDash: boolean;
  }> = [];

  const ensureFlowNode = (
    rawId: string,
    opts?: {
      label?: string;
      shape?: FlowShape;
      bgColor?: string;
      subgraphId?: string;
    },
  ): string => {
    const id = sanitizeIdentifier(rawId, undefined, "N");
    const existing = nodeMap.get(id);
    if (existing) {
      if (opts?.label && existing.label === existing.id) {
        existing.label = opts.label;
      }
      if (opts?.shape) {
        existing.shape = opts.shape;
      }
      if (opts?.bgColor) {
        existing.bgColor = opts.bgColor;
      }
      if (opts?.subgraphId && !existing.subgraphId) {
        existing.subgraphId = opts.subgraphId;
      }
      return id;
    }
    const created: FlowNode = {
      id,
      label: opts?.label || rawId.trim() || id,
      shape: opts?.shape || "rectangle",
      ...(opts?.subgraphId ? { subgraphId: opts.subgraphId } : {}),
      ...(opts?.bgColor ? { bgColor: opts.bgColor } : {}),
    };
    nodeMap.set(id, created);
    return id;
  };

  const ensureSeqParticipant = (
    rawId: string,
    label?: string,
    actor?: boolean,
  ): string => {
    const id = sanitizeIdentifier(rawId, undefined, "P");
    const existing = seqParticipants.get(id);
    if (existing) {
      if (label && existing.label === existing.id) {
        existing.label = label;
      }
      if (actor) {
        existing.actor = true;
      }
      return id;
    }
    seqParticipants.set(id, {
      id,
      label: label || rawId.trim() || id,
      ...(actor ? { actor: true } : {}),
    });
    return id;
  };

  const ARROW_RE =
    /^("[^"]+"|\[[^\]]+\]|\([^)]+\)|[A-Za-z0-9_.-]+)\s*(<?(?:[-.=]+(?:up|down|left|right|u|d|l|r)?[-.=]*)[<>]?)\s*("[^"]+"|\[[^\]]+\]|\([^)]+\)|[A-Za-z0-9_.-]+)(?:\s*:\s*(.*))?$/i;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNum = idx + 1;
    let line = lines[idx].trim();

    if (inBlockComment) {
      const endIdx = line.indexOf("'/");
      if (endIdx !== -1) {
        inBlockComment = false;
        line = line.slice(endIdx + 2).trim();
      } else {
        continue;
      }
    }

    if (line.startsWith("/'")) {
      const closeIdx = line.indexOf("'/", 2);
      if (closeIdx !== -1) {
        line = line.slice(closeIdx + 2).trim();
      } else {
        inBlockComment = true;
        continue;
      }
    }

    if (!line || line.startsWith("'") || line.startsWith("!")) {
      continue;
    }

    if (/^@startuml\b/i.test(line) || /^@enduml\b/i.test(line)) {
      continue;
    }

    if (skipBlockDepth > 0) {
      if (line.endsWith("{")) {
        skipBlockDepth += 1;
      } else if (line === "}") {
        skipBlockDepth -= 1;
      }
      continue;
    }

    if (/^(skinparam|note)\b.*\{$/i.test(line)) {
      skipBlockDepth += 1;
      continue;
    }

    if (
      /^(skinparam|title|header|footer|caption|hide|show|autonumber|scale|activate|deactivate|destroy|note\b)\b/i.test(
        line,
      )
    ) {
      continue;
    }

    if (/^left\s+to\s+right\s+direction$/i.test(line)) {
      direction = "LR";
      continue;
    }
    if (/^top\s+to\s+bottom\s+direction$/i.test(line)) {
      direction = "TD";
      continue;
    }

    if (line === "}") {
      if (subgraphStack.length === 0) {
        throw new Error(
          `PlantUML parse error on line ${lineNum}: unexpected closing "}"`,
        );
      }
      subgraphStack.pop();
      continue;
    }

    // Container / package block: package "Label" as id {
    const pkgMatch = line.match(
      /^(?:package|node|folder|cloud|frame|namespace)\s+(?:"([^"]+)"|([A-Za-z0-9_.-]+))(?:\s+as\s+([A-Za-z0-9_.-]+))?(?:\s+#[0-9a-fA-F]{3,8})?\s*\{$/i,
    );
    if (pkgMatch) {
      forceFlowchart = true;
      const label = decodePlantUmlEscapes(
        pkgMatch[1] || pkgMatch[2] || "Group",
      );
      const rawId = pkgMatch[3] || pkgMatch[2] || label;
      const sgId = sanitizeIdentifier(rawId, undefined, "sg");
      if (!subgraphs.some((s) => s.id === sgId)) {
        subgraphs.push({ id: sgId, label });
      }
      subgraphStack.push(sgId);
      continue;
    }

    // Sequence participants: participant / boundary / control / entity / collections
    const seqDeclMatch = line.match(
      /^(participant|boundary|control|entity|collections)\s+(?:"([^"]+)"|([A-Za-z0-9_.-]+))(?:\s+as\s+([A-Za-z0-9_.-]+))?(?:\s+#[0-9a-fA-F]{3,8})?$/i,
    );
    if (seqDeclMatch) {
      forceSequence = true;
      const label = decodePlantUmlEscapes(
        seqDeclMatch[2] || seqDeclMatch[3] || "",
      );
      const rawId = seqDeclMatch[4] || seqDeclMatch[3] || label;
      ensureSeqParticipant(rawId, label, false);
      continue;
    }

    // Actor (sequence or flowchart)
    const actorDeclMatch = line.match(
      /^actor\s+(?:"([^"]+)"|([A-Za-z0-9_.-]+))(?:\s+as\s+([A-Za-z0-9_.-]+))?(?:\s+(#[0-9a-fA-F]{3,8}))?$/i,
    );
    if (actorDeclMatch) {
      const label = decodePlantUmlEscapes(
        actorDeclMatch[1] || actorDeclMatch[2] || "",
      );
      const rawId = actorDeclMatch[3] || actorDeclMatch[2] || label;
      const color = actorDeclMatch[4];
      ensureSeqParticipant(rawId, label, true);
      ensureFlowNode(rawId, {
        label,
        shape: "ellipse",
        bgColor: color,
        subgraphId: subgraphStack[subgraphStack.length - 1],
      });
      continue;
    }

    // Flowchart shape declaration
    const nodeDeclMatch = line.match(
      /^(rectangle|card|agent|hexagon|diamond|cond|usecase|database|storage|component|circle|ellipse)\s+(?:"([^"]+)"|\[([^\]]+)\]|([A-Za-z0-9_.-]+))(?:\s+as\s+([A-Za-z0-9_.-]+))?(?:\s+(#[0-9a-fA-F]{3,8}))?$/i,
    );
    if (nodeDeclMatch) {
      forceFlowchart = true;
      const kw = nodeDeclMatch[1];
      const rawLabel =
        nodeDeclMatch[2] || nodeDeclMatch[3] || nodeDeclMatch[4] || "";
      const label = decodePlantUmlEscapes(rawLabel);
      const rawId = nodeDeclMatch[5] || nodeDeclMatch[4] || rawLabel;
      const bgColor = nodeDeclMatch[6];
      ensureFlowNode(rawId, {
        label,
        shape: mapPlantUmlKeywordShape(kw),
        bgColor,
        subgraphId: subgraphStack[subgraphStack.length - 1],
      });
      continue;
    }

    // Shorthand [Component] as alias #color or (Usecase) as alias #color
    const shortMatch = line.match(
      /^(?:\[([^\]]+)\]|\(([^)]+)\))(?:\s+as\s+([A-Za-z0-9_.-]+))?(?:\s+(#[0-9a-fA-F]{3,8}))?$/i,
    );
    if (shortMatch) {
      forceFlowchart = true;
      const isEllipse = Boolean(shortMatch[2]);
      const label = decodePlantUmlEscapes(shortMatch[1] || shortMatch[2] || "");
      const rawId = shortMatch[3] || label;
      ensureFlowNode(rawId, {
        label,
        shape: isEllipse ? "ellipse" : "rectangle",
        bgColor: shortMatch[4],
        subgraphId: subgraphStack[subgraphStack.length - 1],
      });
      continue;
    }

    // Edge / sequence message
    const arrowMatch = line.match(ARROW_RE);
    if (arrowMatch) {
      const lhs = unquoteEndpointToken(arrowMatch[1]);
      const opRaw = arrowMatch[2];
      const rhs = unquoteEndpointToken(arrowMatch[3]);
      const label = arrowMatch[4] ? decodePlantUmlEscapes(arrowMatch[4]) : "";

      if (!/^[-.=<>A-Za-z]+$/.test(opRaw) || !/[-.=]/.test(opRaw)) {
        throw new Error(
          `PlantUML parse error on line ${lineNum}: invalid connector "${opRaw}"`,
        );
      }

      const currentSg = subgraphStack[subgraphStack.length - 1];
      const fromFlowId = ensureFlowNode(lhs.idRaw, {
        label: lhs.label,
        shape: lhs.shorthandShape,
        subgraphId: currentSg,
      });
      const toFlowId = ensureFlowNode(rhs.idRaw, {
        label: rhs.label,
        shape: rhs.shorthandShape,
        subgraphId: currentSg,
      });

      const fromSeqId = ensureSeqParticipant(lhs.idRaw, lhs.label);
      const toSeqId = ensureSeqParticipant(rhs.idRaw, rhs.label);

      const cleanOp = opRaw.replace(/[udlr]+|up|down|left|right/gi, "");
      const hasLeft = cleanOp.startsWith("<");
      const hasRight = cleanOp.endsWith(">");
      const isDashed = cleanOp.includes(".");
      const isThick = cleanOp.includes("=");
      const isSingleDash =
        cleanOp === "->" || cleanOp === "->>" || cleanOp === "<-";

      rawArrowRecords.push({
        fromId: fromSeqId,
        toId: toSeqId,
        label,
        op: cleanOp,
        singleDash: isSingleDash,
      });

      let from = fromFlowId;
      let to = toFlowId;
      let bidirectional = false;
      let undirected = false;

      if (hasLeft && hasRight) {
        bidirectional = true;
      } else if (hasLeft && !hasRight) {
        from = toFlowId;
        to = fromFlowId;
      } else if (!hasLeft && !hasRight) {
        undirected = true;
      }

      edges.push({
        from,
        to,
        ...(label ? { label } : {}),
        style: isDashed ? "dashed" : isThick ? "thick" : "solid",
        ...(bidirectional ? { bidirectional: true } : {}),
        ...(undirected ? { undirected: true } : {}),
      });
      continue;
    }

    throw new Error(
      `PlantUML parse error on line ${lineNum}: unrecognized syntax "${line}"`,
    );
  }

  if (subgraphStack.length > 0) {
    throw new Error(
      `PlantUML parse error: unclosed block "${subgraphStack[subgraphStack.length - 1]}"`,
    );
  }
  if (inBlockComment || skipBlockDepth > 0) {
    throw new Error("PlantUML parse error: unclosed comment or block");
  }

  const hasSingleDashSequenceHint =
    !forceFlowchart &&
    seqParticipants.size > 0 &&
    rawArrowRecords.some((r) => r.singleDash);

  if ((forceSequence || hasSingleDashSequenceHint) && !forceFlowchart) {
    for (const r of rawArrowRecords) {
      const style: "solid" | "dashed" =
        r.op.includes("..") || r.op.includes("--") ? "dashed" : "solid";
      seqMessages.push({
        from: r.fromId,
        to: r.toId,
        label: r.label || "message",
        style,
      });
    }
    if (seqParticipants.size === 0 && seqMessages.length === 0) {
      throw new Error("PlantUML diagram contains no elements");
    }
    return {
      kind: "sequence",
      participants: Array.from(seqParticipants.values()),
      messages: seqMessages,
    };
  }

  const nodes = Array.from(nodeMap.values());
  if (nodes.length === 0 && subgraphs.length === 0) {
    throw new Error("PlantUML diagram contains no elements");
  }

  return {
    kind: "flowchart",
    direction,
    subgraphs,
    nodes,
    edges,
  };
}

export function convertPlantUmlToMermaid(code: string): {
  model: DiagramModel;
  mermaid: string;
  bgColors: Map<string, string>;
  strokeColors: Map<string, string>;
} {
  const model = parsePlantUml(code);
  const mermaid = serializeMermaid(model);
  const bgColors = new Map<string, string>();
  const strokeColors = new Map<string, string>();

  if (model.kind === "flowchart") {
    for (const n of model.nodes) {
      if (isCustomHexColor(n.bgColor)) {
        bgColors.set(n.id, n.bgColor);
      }
      if (isCustomStrokeColor(n.strokeColor)) {
        strokeColors.set(n.id, n.strokeColor);
      }
    }
  }

  return { model, mermaid, bgColors, strokeColors };
}
