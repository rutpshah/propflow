import * as vscode from "vscode";
import { GraphBuilder } from "./graphBuilder";
import { ASTAnalyzer } from "./astAnalyzer";
import { PropLineageTreeProvider } from "./treeViewProvider";
import { PropNode } from "./types";

let graphBuilder: GraphBuilder;
let astAnalyzer: ASTAnalyzer;
let treeProvider: PropLineageTreeProvider;
let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  console.log("PropFlow extension is now active");

  // Create output channel for debugging
  outputChannel = vscode.window.createOutputChannel("PropFlow");
  outputChannel.appendLine("PropFlow extension activated");

  // Initialize services
  graphBuilder = new GraphBuilder(outputChannel);
  astAnalyzer = new ASTAnalyzer(outputChannel);
  treeProvider = new PropLineageTreeProvider();

  // Register tree view
  const treeView = vscode.window.createTreeView("propflowLineage", {
    treeDataProvider: treeProvider,
  });

  // Register commands
  const showLineageCommand = vscode.commands.registerCommand(
    "propflow.showLineage",
    async () => {
      await showPropLineage();
    },
  );

  const tracePropCommand = vscode.commands.registerCommand(
    "propflow.traceProp",
    async () => {
      await tracePropUpstream();
    },
  );

  // Add Hover Provider for visual flowchart
  const hoverProvider = new PropFlowHoverProvider(outputChannel);
  const hoverDisposable = vscode.languages.registerHoverProvider(
    [
      { scheme: "file", language: "typescript" },
      { scheme: "file", language: "typescriptreact" },
      { scheme: "file", language: "javascript" },
      { scheme: "file", language: "javascriptreact" },
    ],
    hoverProvider,
  );

  // Add CodeLens provider for inline navigation
  const codeLensProvider = new PropFlowCodeLensProvider();
  const codeLensDisposable = vscode.languages.registerCodeLensProvider(
    [
      { scheme: "file", language: "typescript" },
      { scheme: "file", language: "typescriptreact" },
      { scheme: "file", language: "javascript" },
      { scheme: "file", language: "javascriptreact" },
    ],
    codeLensProvider,
  );

  context.subscriptions.push(
    showLineageCommand,
    tracePropCommand,
    treeView,
    hoverDisposable,
    codeLensDisposable,
  );
}

async function showPropLineage() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor");
    return;
  }

  const document = editor.document;
  const position = editor.selection.active;

  // Get word at cursor (prop name)
  const wordRange = document.getWordRangeAtPosition(position);
  if (!wordRange) {
    vscode.window.showErrorMessage("No prop selected");
    return;
  }

  const propName = document.getText(wordRange);
  const filePath = document.uri.fsPath;

  // Find component name
  const components = astAnalyzer.analyzeFile(filePath);
  const line = position.line + 1;

  let componentName: string | undefined;
  for (const comp of components) {
    if (comp.line <= line) {
      componentName = comp.name;
    }
  }

  if (!componentName) {
    vscode.window.showErrorMessage("Could not determine component");
    return;
  }

  // Show progress
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Tracing prop "${propName}" in ${componentName}...`,
      cancellable: false,
    },
    async () => {
      try {
        const trace = await graphBuilder.buildPropChain(
          filePath,
          componentName!,
          propName,
        );

        if (trace.chain.length === 0) {
          vscode.window.showInformationMessage("Trace not found");
          return;
        }

        treeProvider.setTrace(trace);

        let message = `Found ${trace.chain.length} levels in prop chain`;
        if (trace.ambiguous) {
          message += " (contains spread operators)";
        }

        vscode.window
          .showInformationMessage(
            message,
            "View in PropFlow Lineage Panel",
            "Dismiss",
          )
          .then((selection) => {
            if (selection === "View in PropFlow Lineage Panel") {
              vscode.commands.executeCommand("propflowLineage.focus");
            }
          });
      } catch (error) {
        vscode.window.showErrorMessage(`Error tracing prop: ${error}`);
      }
    },
  );
}

async function tracePropUpstream() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor");
    return;
  }

  const document = editor.document;
  const position = editor.selection.active;

  const wordRange = document.getWordRangeAtPosition(position);
  if (!wordRange) {
    vscode.window.showErrorMessage("No prop selected");
    return;
  }

  const propName = document.getText(wordRange);
  const filePath = document.uri.fsPath;

  const components = astAnalyzer.analyzeFile(filePath);
  const line = position.line + 1;

  let componentName: string | undefined;
  for (const comp of components) {
    if (comp.line <= line) {
      componentName = comp.name;
    }
  }

  if (!componentName) {
    vscode.window.showErrorMessage("Could not determine component");
    return;
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Navigating to parent...",
      cancellable: false,
    },
    async () => {
      try {
        const trace = await graphBuilder.buildPropChain(
          filePath,
          componentName!,
          propName,
        );

        if (trace.chain.length < 2) {
          vscode.window.showInformationMessage("No parent component found");
          return;
        }

        // Navigate to parent (second item in chain after reversing)
        const parent = trace.chain[1];
        const uri = vscode.Uri.file(parent.filePath);
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc);

        const pos = new vscode.Position(parent.lineCode - 1, 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos));
      } catch (error) {
        vscode.window.showErrorMessage(`Error navigating: ${error}`);
      }
    },
  );
}

class PropFlowHoverProvider implements vscode.HoverProvider {
  constructor(private outputChannel: vscode.OutputChannel) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    this.outputChannel.appendLine("\n=== Hover triggered ===");
    this.outputChannel.appendLine(`File: ${document.fileName}`);
    this.outputChannel.appendLine(
      `Line: ${position.line + 1}, Column: ${position.character}`,
    );

    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) {
      this.outputChannel.appendLine("No word at position");
      return undefined;
    }

    const word = document.getText(wordRange);
    this.outputChannel.appendLine(`Word: ${word}`);
    const filePath = document.uri.fsPath;

    // Only process React files
    if (!filePath.match(/\.(tsx?|jsx?)$/)) {
      this.outputChannel.appendLine("Not a React file, skipping");
      return undefined;
    }

    try {
      // Find component name
      const components = astAnalyzer.analyzeFile(filePath);
      this.outputChannel.appendLine(
        `Found ${components.length} components in file`,
      );

      const line = position.line + 1;

      let componentName: string | undefined;
      for (const comp of components) {
        this.outputChannel.appendLine(
          `Component: ${comp.name} at line ${comp.line}, props: ${comp.props.join(", ")}`,
        );
        if (comp.line <= line) {
          componentName = comp.name;
        }
      }

      if (!componentName) {
        this.outputChannel.appendLine("No component found at this position");
        return undefined;
      }

      this.outputChannel.appendLine(`Current component: ${componentName}`);

      // Check if this is a prop
      const component = components.find((c) => c.name === componentName);
      if (!component || !component.props.includes(word)) {
        this.outputChannel.appendLine(
          `"${word}" is not a prop of ${componentName}`,
        );
        return undefined;
      }

      this.outputChannel.appendLine(`"${word}" is a prop! Building trace...`);

      // Build the trace
      const trace = await graphBuilder.buildPropChain(
        filePath,
        componentName,
        word,
      );

      this.outputChannel.appendLine(
        `Trace complete. Chain length: ${trace.chain.length}`,
      );

      if (trace.chain.length === 0) {
        this.outputChannel.appendLine("Empty trace chain");
        return undefined;
      }

      // If only one component (no parent found), show a simple message
      if (trace.chain.length === 1) {
        const markdown = new vscode.MarkdownString();
        markdown.appendMarkdown("### 🔍 Prop Flow Trace\n\n");
        markdown.appendMarkdown(
          `**${word}** is defined in **${componentName}**\n\n`,
        );
        markdown.appendMarkdown("*No parent component found.*\n\n");
        markdown.appendMarkdown("This could mean:\n");
        markdown.appendMarkdown("- Component not yet used in the codebase\n");
        markdown.appendMarkdown("- External/library component\n");
        markdown.appendMarkdown("- Root level component\n\n");
        markdown.appendMarkdown(
          '💡 *Tip: Make sure the component is imported and used in JSX elsewhere (e.g., `<Test variant="..." />`)*\n',
        );
        return new vscode.Hover(markdown, wordRange);
      }

      // Create visual flowchart
      const markdown = new vscode.MarkdownString();
      markdown.isTrusted = true;
      markdown.supportHtml = true;

      markdown.appendMarkdown("### 🔍 Prop Flow Trace\n\n");
      markdown.appendMarkdown("```\n");

      // Build the tree visualization
      const tree = buildFlowChart(trace.chain);
      markdown.appendMarkdown(tree);

      markdown.appendMarkdown("\n```\n\n");

      if (trace.ambiguous) {
        markdown.appendMarkdown(
          "⚠️ *Contains spread operators - trace may be incomplete*\n\n",
        );
      }

      // Add clickable links
      markdown.appendMarkdown("---\n\n");
      for (let i = 0; i < trace.chain.length; i++) {
        const node = trace.chain[i];
        const fileName = node.filePath.split("/").pop();
        const icon = getNodeIcon(node.type);
        markdown.appendMarkdown(
          `${icon} **${node.componentName}** → \`${node.propName}\` `,
        );
        markdown.appendMarkdown(
          `([${fileName}:${node.lineCode}](${vscode.Uri.file(node.filePath).toString()}#${node.lineCode}))\n\n`,
        );
      }

      return new vscode.Hover(markdown, wordRange);
    } catch (error) {
      return undefined;
    }
  }
}

function buildFlowChart(chain: PropNode[]): string {
  let chart = "";

  for (let i = 0; i < chain.length; i++) {
    const node = chain[i];
    const indent = "  ".repeat(i);
    const icon = getNodeIcon(node.type);
    const isLast = i === chain.length - 1;

    if (i === 0) {
      chart += `${icon} ${node.componentName} (SOURCE)\n`;
      chart += `    └─ prop: "${node.propName}"\n`;
    } else {
      chart += `${indent}    ↓\n`;
      chart += `${indent}${icon} ${node.componentName}\n`;
      chart += `${indent}    └─ prop: "${node.propName}"`;
      if (node.type === "USAGE") {
        chart += " (passed through)";
      }
      chart += "\n";
    }
  }

  return chart;
}

function getNodeIcon(type: string): string {
  switch (type) {
    case "SOURCE":
      return "🟢";
    case "USAGE":
      return "🔵";
    case "DEFINITION":
      return "🟣";
    default:
      return "⚪";
  }
}

class PropFlowCodeLensProvider implements vscode.CodeLensProvider {
  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    const codeLenses: vscode.CodeLens[] = [];
    const filePath = document.uri.fsPath;

    // Only process React files
    if (!filePath.match(/\.(tsx?|jsx?)$/)) {
      return codeLenses;
    }

    try {
      const components = astAnalyzer.analyzeFile(filePath);

      for (const component of components) {
        const line = component.line - 1;
        const range = new vscode.Range(line, 0, line, 0);

        const lens = new vscode.CodeLens(range, {
          title: `⬆ Trace Props`,
          command: "propflow.showLineage",
          arguments: [],
        });

        codeLenses.push(lens);
      }
    } catch (error) {
      // Silently fail for CodeLens
    }

    return codeLenses;
  }
}

export function deactivate() {
  if (graphBuilder) {
    graphBuilder.dispose();
  }
  if (astAnalyzer) {
    astAnalyzer.dispose();
  }
}
