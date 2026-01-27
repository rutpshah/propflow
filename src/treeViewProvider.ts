import * as vscode from "vscode";
import { PropNode, PropTrace } from "./types";
import * as path from "path";

export class PropLineageTreeProvider implements vscode.TreeDataProvider<PropTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<
    PropTreeItem | undefined | null | void
  >();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private currentTrace: PropTrace | null = null;

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  setTrace(trace: PropTrace | null): void {
    this.currentTrace = trace;
    this.refresh();
  }

  getTreeItem(element: PropTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: PropTreeItem): Thenable<PropTreeItem[]> {
    if (!this.currentTrace) {
      return Promise.resolve([]);
    }

    if (!element) {
      // Root level - show the chain
      const items = this.currentTrace.chain.map((node, index) => {
        return new PropTreeItem(
          node,
          index === 0
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.None,
          index,
        );
      });
      return Promise.resolve(items);
    }

    return Promise.resolve([]);
  }
}

export class PropTreeItem extends vscode.TreeItem {
  constructor(
    public readonly node: PropNode,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    private index: number,
  ) {
    super(node.componentName, collapsibleState);

    this.tooltip = this.getTooltip();
    this.description = this.getDescription();
    this.iconPath = this.getIcon();

    // Enable click to navigate to file
    this.command = {
      command: "vscode.open",
      title: "Open File",
      arguments: [
        vscode.Uri.file(node.filePath),
        {
          selection: new vscode.Range(
            new vscode.Position(node.lineCode - 1, 0),
            new vscode.Position(node.lineCode - 1, 0),
          ),
        },
      ],
    };
  }

  private getTooltip(): string {
    const fileName = path.basename(this.node.filePath);
    return `${this.node.componentName} (${fileName}:${this.node.lineCode})\nProp: ${this.node.propName}\nType: ${this.node.type}`;
  }

  private getDescription(): string {
    const fileName = path.basename(this.node.filePath);
    return `${this.node.propName} • ${fileName}:${this.node.lineCode}`;
  }

  private getIcon(): vscode.ThemeIcon {
    switch (this.node.type) {
      case "SOURCE":
        return new vscode.ThemeIcon(
          "symbol-constant",
          new vscode.ThemeColor("charts.green"),
        );
      case "USAGE":
        return new vscode.ThemeIcon(
          "symbol-parameter",
          new vscode.ThemeColor("charts.blue"),
        );
      case "DEFINITION":
        return new vscode.ThemeIcon(
          "symbol-interface",
          new vscode.ThemeColor("charts.purple"),
        );
      default:
        return new vscode.ThemeIcon("symbol-misc");
    }
  }

  contextValue = "propNode";
}
