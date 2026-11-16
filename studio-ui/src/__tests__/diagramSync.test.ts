import { describe, it, expect } from "vitest";
import {
  excalidrawToMermaid,
  excalidrawToPlantUml,
  extractDiagramFromExcalidraw,
  mermaidToExcalidraw,
  parsePlantUml,
  plantUmlToExcalidraw,
} from "../diagramSync";

describe("Two-way Mermaid / PlantUML <-> Excalidraw sync", () => {
  it("1. round-trips Mermaid flowchart -> Excalidraw -> Mermaid & PlantUML", async () => {
    const mermaidInput = [
      "flowchart LR",
      '  subgraph sg1["Backend Tier"]',
      '    B{"Auth Check"}',
      '    C(("Rust API"))',
      '    DB[("Postgres DB")]',
      "  end",
      '  A["Browser UI"]',
      '  A -.->|"HTTPS"| B',
      '  B -->|"ok"| C',
      '  C -->|"SQL"| DB',
      "",
    ].join("\n");

    const elements = await mermaidToExcalidraw(mermaidInput);
    expect(elements.length).toBeGreaterThan(5);

    const model = extractDiagramFromExcalidraw(elements);
    expect(model.kind).toBe("flowchart");
    if (model.kind !== "flowchart") {
      throw new Error("Expected flowchart model");
    }

    expect(model.direction).toBe("LR");
    expect(model.subgraphs.map((s) => s.label)).toContain("Backend Tier");

    const nodeIds = model.nodes.map((n) => n.id);
    expect(nodeIds).toEqual(expect.arrayContaining(["A", "B", "C", "DB"]));
    expect(model.nodes.find((n) => n.id === "B")?.shape).toBe("diamond");
    expect(model.nodes.find((n) => n.id === "C")?.shape).toBe("ellipse");
    expect(model.nodes.find((n) => n.id === "DB")?.shape).toBe("database");

    const mmdOut = excalidrawToMermaid(elements);
    expect(mmdOut).toContain("flowchart LR");
    expect(mmdOut).toContain('subgraph sg1["Backend Tier"]');
    expect(mmdOut).toContain('A["Browser UI"]');
    expect(mmdOut).toContain('B{"Auth Check"}');
    expect(mmdOut).toContain('DB[("Postgres DB")]');
    expect(mmdOut).toContain('A -.->|"HTTPS"| B');
    expect(mmdOut).toContain('B -->|"ok"| C');

    const pumlOut = excalidrawToPlantUml(elements);
    expect(pumlOut).toContain("@startuml");
    expect(pumlOut).toContain("left to right direction");
    expect(pumlOut).toContain('package "Backend Tier" as sg1');
    expect(pumlOut).toContain('database "Postgres DB" as DB');
    expect(pumlOut).toContain("A ..> B : HTTPS");
    expect(pumlOut).toContain("B --> C : ok");
    expect(pumlOut).toContain("@enduml");
  });

  it("2. round-trips PlantUML component/flowchart -> Excalidraw -> PlantUML & Mermaid", async () => {
    const pumlInput = [
      "@startuml",
      "left to right direction",
      'package "Core Cluster" as core {',
      '  rectangle "Gateway" as gw #e7f5ff',
      '  hexagon "Policy Engine" as policy',
      '  database "Ledger" as db',
      "}",
      'usecase "End User" as user',
      "user --> gw : HTTPS",
      "gw ..> policy : Authorize",
      "policy <--> db : Read/Write",
      "@enduml",
      "",
    ].join("\n");

    const parsed = parsePlantUml(pumlInput);
    expect(parsed.kind).toBe("flowchart");

    const { elements } = await plantUmlToExcalidraw(pumlInput);
    const gwEl = elements.find((el) => el.id === "gw");
    expect(gwEl?.backgroundColor).toBe("#e7f5ff");

    const pumlOut = excalidrawToPlantUml(elements);
    expect(pumlOut).toContain("left to right direction");
    expect(pumlOut).toContain('package "Core Cluster" as core');
    expect(pumlOut).toContain('rectangle "Gateway" as gw #e7f5ff');
    expect(pumlOut).toContain('hexagon "Policy Engine" as policy');
    expect(pumlOut).toContain('database "Ledger" as db');
    expect(pumlOut).toContain('usecase "End User" as user');
    expect(pumlOut).toContain("user --> gw : HTTPS");
    expect(pumlOut).toContain("gw ..> policy : Authorize");
    expect(pumlOut).toContain("policy <--> db : Read/Write");

    const mmdOut = excalidrawToMermaid(elements);
    expect(mmdOut).toContain("flowchart LR");
    expect(mmdOut).toContain('gw["Gateway"]');
    expect(mmdOut).toContain('db[("Ledger")]');
    expect(mmdOut).toContain("style gw fill:#e7f5ff");
    expect(mmdOut).toContain('policy <-->|"Read/Write"| db');
  });

  it("3. extracts live Excalidraw canvas edits (rename, hand-drawn box + proximity arrow, delete) into Mermaid & PlantUML", async () => {
    const baseElements = await mermaidToExcalidraw(
      "flowchart LR\n  A[\"Client\"] --> B[\"Server\"]\n  B --> C[\"Storage\"]\n",
    );

    // 1) Rename bound text on node B ("Server" -> "Rust Axum API")
    // 2) Delete node C and edge B_C
    // 3) Add a brand-new hand-drawn rectangle + bound text + unbound proximity arrow from B -> Cache
    const mutated = baseElements.map((el) => {
      if (el.type === "text" && el.containerId === "B") {
        return { ...el, text: "Rust Axum API", originalText: "Rust Axum API" };
      }
      if (el.id === "C" || el.containerId === "C" || el.id === "B_C") {
        return { ...el, isDeleted: true };
      }
      return el;
    });

    const bBox = mutated.find((el) => el.id === "B")!;
    const cacheX = (bBox.x ?? 300) + (bBox.width ?? 120) + 90;
    const cacheY = bBox.y ?? 50;

    mutated.push(
      {
        id: "handRect1",
        type: "rectangle",
        x: cacheX,
        y: cacheY,
        width: 140,
        height: 60,
        backgroundColor: "#ffffff",
        strokeColor: "#1e1e1e",
        isDeleted: false,
      },
      {
        id: "handTxt1",
        type: "text",
        containerId: "handRect1",
        text: "Redis Cache",
        originalText: "Redis Cache",
        x: cacheX + 20,
        y: cacheY + 18,
        width: 100,
        height: 24,
        isDeleted: false,
      },
      {
        id: "handArr1",
        type: "arrow",
        x: (bBox.x ?? 300) + (bBox.width ?? 120) + 5,
        y: (bBox.y ?? 50) + (bBox.height ?? 60) / 2,
        width: 80,
        height: 0,
        points: [
          [0, 0],
          [80, 0],
        ],
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        strokeStyle: "dashed",
        isDeleted: false,
      },
      {
        id: "handArrTxt",
        type: "text",
        containerId: "handArr1",
        text: "cache hit",
        originalText: "cache hit",
        x: (bBox.x ?? 300) + (bBox.width ?? 120) + 20,
        y: (bBox.y ?? 50) + 10,
        width: 60,
        height: 20,
        isDeleted: false,
      },
    );

    const mmd = excalidrawToMermaid(mutated);
    expect(mmd).toContain('B["Rust Axum API"]');
    expect(mmd).toContain("Redis Cache");
    expect(mmd).toContain("cache hit");
    expect(mmd).not.toContain('C["Storage"]');

    const puml = excalidrawToPlantUml(mutated);
    expect(puml).toContain('rectangle "Rust Axum API" as B');
    expect(puml).toContain("Redis Cache");
    expect(puml).toContain("..>");
    expect(puml).toContain(": cache hit");
    expect(puml).not.toContain("Storage");
  });

  it("4. smart-merges code edits onto canvas preserving custom node colors and non-graph drawings", async () => {
    const initial = await mermaidToExcalidraw(
      'flowchart LR\n  A["Browser"] --> B["API"]\n',
    );

    const withCustomStyleAndSketch = [
      ...initial.map((el) =>
        el.id === "B" ? { ...el, backgroundColor: "#ffec99" } : el,
      ),
      {
        id: "sketch_1",
        type: "freedraw",
        x: 10,
        y: 300,
        width: 40,
        height: 20,
        points: [
          [0, 0],
          [40, 20],
        ],
        isDeleted: false,
      },
    ];

    const updatedElements = await mermaidToExcalidraw(
      'flowchart LR\n  A["Browser"] --> B["API v2"]\n  B --> C["Queue"]\n',
      withCustomStyleAndSketch,
    );

    const updatedB = updatedElements.find((el) => el.id === "B");
    expect(updatedB?.backgroundColor).toBe("#ffec99");

    const updatedBText = updatedElements.find(
      (el) => el.type === "text" && el.containerId === "B",
    );
    expect(updatedBText?.originalText).toBe("API v2");

    const addedC = updatedElements.find((el) => el.id === "C");
    expect(addedC).toBeDefined();

    const preservedSketch = updatedElements.find((el) => el.id === "sketch_1");
    expect(preservedSketch).toBeDefined();
    expect(preservedSketch?.type).toBe("freedraw");
  });

  it("5. two-way syncs sequence diagrams between PlantUML, Excalidraw, and Mermaid", async () => {
    const pumlSeq = [
      "@startuml",
      'participant "Browser UI" as Browser',
      'participant "Rust Server" as Server',
      "Browser -> Server : PUT scene",
      "Server --> Browser : 200 Saved",
      "@enduml",
    ].join("\n");

    const { elements } = await plantUmlToExcalidraw(pumlSeq);
    const seqModel = extractDiagramFromExcalidraw(elements);
    expect(seqModel.kind).toBe("sequence");

    // Simulate user editing the first sequence message label on the canvas
    const messageArrows = elements
      .filter((el) => el.type === "arrow")
      .sort((a, b) => (a.y ?? 0) - (b.y ?? 0));
    expect(messageArrows.length).toBe(2);

    const editedElements = elements.map((el) =>
      el.type === "text" && el.containerId === messageArrows[0].id
        ? { ...el, text: "PUT scene + mmd", originalText: "PUT scene + mmd" }
        : el,
    );

    const mmdOut = excalidrawToMermaid(editedElements);
    expect(mmdOut).toContain("sequenceDiagram");
    expect(mmdOut).toContain("participant Browser as Browser UI");
    expect(mmdOut).toContain("Browser->>Server: PUT scene + mmd");
    expect(mmdOut).toContain("Server-->>Browser: 200 Saved");

    const pumlOut = excalidrawToPlantUml(editedElements);
    expect(pumlOut).toContain('participant "Browser UI" as Browser');
    expect(pumlOut).toContain("Browser -> Server : PUT scene + mmd");
    expect(pumlOut).toContain("Server --> Browser : 200 Saved");
  });

  it("6. rejects broken Mermaid and PlantUML syntax with clear errors", async () => {
    await expect(
      mermaidToExcalidraw("flowchart LR\n  A -->\n"),
    ).rejects.toThrow();

    await expect(
      mermaidToExcalidraw("totally invalid diagram text"),
    ).rejects.toThrow();

    expect(() =>
      parsePlantUml('@startuml\npackage "Unclosed" {\n  rectangle "A" as A\n@enduml'),
    ).toThrow(/unclosed block/i);

    await expect(
      plantUmlToExcalidraw("@startuml\nA -->\n@enduml"),
    ).rejects.toThrow(/PlantUML parse error/i);
  });
});
