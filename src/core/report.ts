import pc from "picocolors";

export interface Finding {
  level: "ok" | "info" | "warn";
  title: string;
  detail?: string;
}

const LEVEL_WIDTH = 4; // "ok" + padding = 4, "info" = 4, "warn" = 4

function badge(level: Finding["level"]): string {
  switch (level) {
    case "ok":
      return pc.green("ok  ");
    case "info":
      return pc.cyan("info");
    case "warn":
      return pc.yellow("warn");
  }
}

export function renderFindings(findings: Finding[]): void {
  for (const f of findings) {
    const b = badge(f.level);
    console.log(`  ${b}  ${f.title}`);
    if (f.detail) {
      // Indent detail lines by 8 spaces to align under title
      const indented = f.detail
        .split("\n")
        .map((line) => `        ${line}`)
        .join("\n");
      console.log(indented);
    }
  }
}

export function renderFinding(f: Finding): void {
  renderFindings([f]);
}
